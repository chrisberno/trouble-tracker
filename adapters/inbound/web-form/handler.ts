import { createTicket } from '@/pp-client/index';
import type { CoreEvent, DeploymentConfig } from '@/pp-client/types';
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
  // 2026-05-15: include the constructed ticket.created CoreEvent so the
  // route handler can dispatch the Twilio Flex bridge in-process via
  // next/server's after(). This is the fast-path that sidesteps the
  // PP-webhook race-loss path entirely. Present only when status='success'.
  ticketCreatedEvent?: Extract<CoreEvent, { kind: 'ticket.created' }>;
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

    // TTB-17 fix #3 — pre-write scope to bridge-db.
    // bridge-db is the source of truth for ticketId→scope across both
    // surfaces that read it: (a) the /bridge/tickets iframe page, which
    // resolves scope from bridge-db via ticketId URL param, and (b) the
    // bridge handler at adapters/bridge/human/twilio-flex/handlers.ts,
    // which reads bridge-db at the top of onTicketCreated. PP REST does
    // not return custom_fields in GET /api/tickets/<id> (verified
    // 2026-05-06) and PP's ticket.created webhook payload does not yield
    // them via readCustomField either (verified 2026-05-15 — ticket #93
    // post-9b9877b smoke).
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

    // 2026-05-15: pub/sub publish() removed from this handler. The 2026-05-07
    // synthetic publish was a no-op in production due to bundler tree-shake
    // (Vercel per-route runtime isolation — see comments at the prior
    // publish() site in git history). Replaced by direct in-process dispatch
    // via the route handler's next/server `after()` call, using the
    // ticketCreatedEvent returned below. This eliminates the pp-webhook
    // race-loss path (the bridge handler now runs with scope already known
    // from intake, before PP's webhook fires).

    const ticketCreatedEvent: Extract<CoreEvent, { kind: 'ticket.created' }> = {
      kind: 'ticket.created',
      ticket: { ...ticket, customerScope },
    };

    return { status: 'success', ticketId: ticket.id, ticketCreatedEvent };
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
