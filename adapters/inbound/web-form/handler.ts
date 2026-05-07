import { createTicket, publish } from '@/pp-client/index';
import type { DeploymentConfig } from '@/pp-client/types';
import {
  PpClientServerError,
  PpClientRateLimitError,
  PpClientAuthError,
} from '@/pp-client/types';
import { prewriteBridgeMappingScope } from '@/adapters/bridge/human/twilio-flex/bridge-db';

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

    // TTB-17 fix #3 — pre-write scope to bridge-db BEFORE PP fires its
    // ticket.created webhook. PP REST does not return custom_fields in
    // GET /api/tickets/<id>, so the bridge handler can't read the scope from
    // PP's webhook payload. By pre-writing the scope here (with the original
    // input value, not the empty PP-roundtrip value), the bridge handler in
    // /api/pp-webhook reads this row and uses its scope as authoritative.
    //
    // This sidesteps a bundler/runtime issue surfaced 2026-05-07: the
    // synthetic in-process publish() from this route was not invoking the
    // bridge subscriber registered in /api/intake's runtime (Vercel function
    // logs confirmed every onTicketCreated invocation came from the
    // /api/pp-webhook function, never from /api/intake). Whether due to
    // tree-shake, per-route module duplication, or some other bundler quirk,
    // forcing dependency on cross-route in-process pub/sub is fragile. The
    // bridge-db pre-write is bundler-agnostic — both routes share the
    // Postgres backend.
    try {
      await prewriteBridgeMappingScope(ticket.id, customerScope);
    } catch (prewriteErr) {
      console.warn(
        JSON.stringify({
          web_form_intake: true,
          warning: 'prewriteBridgeMappingScope failed; PP webhook will see empty scope',
          ticketId: ticket.id,
          error: prewriteErr instanceof Error ? prewriteErr.message : String(prewriteErr),
        }),
      );
    }

    // Synthetic publish kept as belt-and-suspenders. If the bundler/runtime
    // issue gets resolved later, this provides fast-path bridge dispatch
    // without waiting for PP's webhook round-trip. Currently a no-op in
    // production (subscriber map empty) but harmless and self-recovering.
    try {
      await publish({
        kind: 'ticket.created',
        ticket: { ...ticket, customerScope },
      });
    } catch (publishErr) {
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
