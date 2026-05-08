// adapters/outbound/customer-email/register.ts
//
// Subscribes the customer-email adapter to PP events. Called once at module
// load from any route that participates in PP webhook dispatch (currently
// /api/pp-webhook/route.ts). Module-scope register call is idempotent via
// the `registered` guard below, mirroring the Twilio Flex bridge pattern.
//
// IMPORTANT: this adapter must NOT depend on the Twilio Flex bridge running
// in the same dispatch — they are independent fan-outs of the same PP event.
// Failures in one don't affect the other.

import { subscribe } from '@/pp-client';
import type { Ticket } from '@/pp-client/types';
import { getBridgeMappingByTicketId } from '@/adapters/bridge/human/twilio-flex/bridge-db';
import { sendTicketCreatedEmail, sendAgentReplyEmail } from './index';
import { getTicket } from '@/pp-client';
import type { DeploymentConfig } from '@/pp-client/types';

let registered = false;

export function register(deployment: DeploymentConfig): void {
  if (registered) return;
  registered = true;

  // ticket.created — confirmation to submitter.
  subscribe(['ticket.created'], async (event) => {
    if (event.kind !== 'ticket.created') return;
    try {
      // Hydrate scope from bridge-db (PP's getTicket / webhook payload omits
      // custom_fields; bridge-db is the source of truth — TTB-17 architecture).
      const enriched = await enrichScopeFromBridgeDb(event.ticket);
      await sendTicketCreatedEmail(enriched);
    } catch (err) {
      console.warn(JSON.stringify({
        customer_email: true,
        warning: 'sendTicketCreatedEmail threw; not retrying',
        ticketId: event.ticket.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  });

  // ticket.replied.agent — reply notification to submitter.
  // event.reply has the body but the customer email lives on the Ticket.
  // PP's webhook puts the reply object in the event but the ticket may need
  // a fresh fetch (the event payload only has rawTicket, not the normalized
  // form with customer email reliably populated). getTicket() round-trip is
  // ~300ms and only fires for agent-replies which are infrequent — acceptable.
  subscribe(['ticket.replied.agent'], async (event) => {
    if (event.kind !== 'ticket.replied.agent') return;
    try {
      const ticket = await getTicket(event.ticketId, deployment);
      const enriched = await enrichScopeFromBridgeDb(ticket);
      await sendAgentReplyEmail({ ticket: enriched, reply: event.reply });
    } catch (err) {
      console.warn(JSON.stringify({
        customer_email: true,
        warning: 'sendAgentReplyEmail threw; not retrying',
        ticketId: event.ticketId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  });

  console.log(JSON.stringify({
    customer_email: true,
    info: 'registered subscribers',
    events: ['ticket.created', 'ticket.replied.agent'],
  }));
}

// Bridge-db has the canonical ticketId→scope binding (TTB-17). PP's webhook
// payload + REST omit custom_fields. We attach scope here so email tags
// include `scope-NSS` etc. — useful for Mailgun-side filtering, not strictly
// required for delivery.
async function enrichScopeFromBridgeDb(ticket: Ticket): Promise<Ticket> {
  if (ticket.customerScope) return ticket;
  try {
    const mapping = await getBridgeMappingByTicketId(ticket.id);
    const scope = mapping?.customerScope?.trim();
    if (scope) return { ...ticket, customerScope: scope };
  } catch {
    // Non-fatal — fall through with scope ''.
  }
  return ticket;
}
