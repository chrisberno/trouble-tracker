import { createTicket, publish } from '@/pp-client/index';
import type { DeploymentConfig } from '@/pp-client/types';
import {
  PpClientServerError,
  PpClientRateLimitError,
  PpClientAuthError,
} from '@/pp-client/types';

export interface WebFormIntakePayload {
  title: string;
  description: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerScope: string;
  // NOTE: customerEmail added mid-Phase-2 — PP.app /api/contacts requires it.
  // Company still omitted per CEO defaults.
}

export interface IntakeResult {
  status: 'success' | 'failure';
  ticketId?: string;
  errorMessage?: string;
}

export async function handleWebFormIntake(
  payload: WebFormIntakePayload,
  deployment: DeploymentConfig,
): Promise<IntakeResult> {
  const title = (payload.title ?? '').trim();
  const description = (payload.description ?? '').trim();
  const customerName = (payload.customerName ?? '').trim();
  const customerEmail = (payload.customerEmail ?? '').trim();
  const customerPhoneRaw = (payload.customerPhone ?? '').trim();
  const customerScope = (payload.customerScope ?? '').trim();

  const missing: string[] = [];
  if (!title) missing.push('title');
  if (!description) missing.push('description');
  if (!customerName) missing.push('customerName');
  if (!customerEmail) missing.push('customerEmail');
  if (!customerPhoneRaw) missing.push('customerPhone');
  if (!customerScope) missing.push('customerScope');
  if (missing.length > 0) {
    return {
      status: 'failure',
      errorMessage: `Missing required fields: ${missing.join(', ')}`,
    };
  }

  if (!/^.+@.+\..+$/.test(customerEmail)) {
    return {
      status: 'failure',
      errorMessage: 'Please enter a valid email address.',
    };
  }

  const customerPhone = customerPhoneRaw.replace(/\D/g, '');

  try {
    const ticket = await createTicket(
      {
        subject: title,
        description,
        priority: 'medium',
        customer: { name: customerName, email: customerEmail, phone: customerPhone },
        customerScope,
        intakeSource: 'web-form',
      },
      deployment,
    );
    console.log(
      JSON.stringify({
        web_form_intake: true,
        status: 'success',
        ticketId: ticket.id,
      }),
    );

    // TTB-17: synthetic publish of ticket.created with the original
    // customerScope from the request body. PP REST does not return
    // custom_fields, so the normalized ticket returned by createTicket has an
    // empty customerScope (verified 2026-05-06 with TT tenant token). The PP
    // ticket.created webhook will fire shortly after this and re-publish the
    // same event, but bridge-side idempotency on `twilio:task:<ticket.id>`
    // makes the second invocation a no-op. We synthesize here with
    // customerScope overridden to the original input so the bridge gets the
    // value it needs to populate task.attributes.customerScope and bridge-db
    // customer_scope index.
    try {
      await publish({
        kind: 'ticket.created',
        ticket: { ...ticket, customerScope },
      });
    } catch (publishErr) {
      // Bridge errors don't fail the intake response — the customer-facing
      // submit succeeded; bridge fan-out is best-effort. The PP webhook is the
      // safety net.
      console.warn(
        JSON.stringify({
          web_form_intake: true,
          warning: 'synthetic publish failed; PP webhook is fallback',
          ticketId: ticket.id,
          error: publishErr instanceof Error ? publishErr.message : String(publishErr),
        }),
      );
    }

    return { status: 'success', ticketId: ticket.id };
  } catch (err) {
    if (
      err instanceof PpClientServerError ||
      err instanceof PpClientRateLimitError ||
      err instanceof PpClientAuthError
    ) {
      console.log(
        JSON.stringify({
          web_form_intake: true,
          status: 'failure',
          error: err.message,
        }),
      );
      return {
        status: 'failure',
        errorMessage: 'Support system temporarily unavailable. Please try again shortly.',
      };
    }
    console.log(
      JSON.stringify({
        web_form_intake: true,
        status: 'failure',
        error: String(err),
      }),
    );
    return {
      status: 'failure',
      errorMessage: 'An unexpected error occurred. Please try again.',
    };
  }
}
