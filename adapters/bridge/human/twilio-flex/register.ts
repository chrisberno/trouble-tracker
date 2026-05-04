// adapters/bridge/human/twilio-flex/register.ts
// Wires bridge handlers to pp-client's event dispatch via subscribe().
// Called once at module load by app/api/pp-webhook/route.ts.
//
// Design: small + explicit. No generic event bus; each pp-client event kind
// maps to a single bridge handler.
//
// Phase 4 (2026-05-04): re-added ticket.replied.customer subscription that
// was removed in Phase 3 v2 pivot. Customer replies on PP now flow into the
// linked Twilio Conversation so the agent sees them inline in Flex Task
// Canvas's native email-style UI.

import { subscribe } from '@/pp-client';
import type { TwilioBridgeConfig } from './types';
import { buildTwilioClient } from './twilio-client';
import { onTicketCreated, onTicketRepliedAgent, onTicketRepliedCustomer } from './handlers';

let registered = false;

export function register(config: TwilioBridgeConfig): void {
  if (registered) {
    // Idempotent — pp-client.subscribe is also idempotent at the handlers map
    // level, but we add an extra guard to keep logs clean on hot module reloads.
    return;
  }
  registered = true;

  const twilio = buildTwilioClient(config);

  subscribe(['ticket.created'], async (event) => {
    if (event.kind !== 'ticket.created') return;
    await onTicketCreated(event, twilio);
  });

  subscribe(['ticket.replied.customer'], async (event) => {
    if (event.kind !== 'ticket.replied.customer') return;
    await onTicketRepliedCustomer(event, twilio);
  });

  subscribe(['ticket.replied.agent'], async (event) => {
    if (event.kind !== 'ticket.replied.agent') return;
    await onTicketRepliedAgent(event, twilio);
  });

  // Phase 4 events NOT subscribed:
  //   - ticket.status_changed / ticket.resolved / ticket.closed / ticket.deleted
  //
  // Phase 5+ may add ticket.status_changed for proactive Conversation closeout
  // (e.g., post a "ticket closed" system message into the Conversation when
  // status transitions to closed).

  console.log(JSON.stringify({
    bridge: 'twilio-flex',
    info: 'registered handlers',
    phase: '4-email-pattern-ux',
    deploymentId: config.deploymentId,
    workspaceSid: config.workspaceSid,
    conversationsServiceSid: config.conversationsServiceSid,
  }));
}
