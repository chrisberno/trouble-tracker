// adapters/bridge/human/twilio-flex/register.ts
// Wires bridge handlers to pp-client's event dispatch via subscribe().
// Called once at module load by app/api/pp-webhook/route.ts.
//
// Design: small + explicit. No generic event bus; each pp-client event kind
// maps to a single bridge handler.
//
// Phase 3 v2 (2026-05-04 pivot): TaskRouter Tasks API only. No Conversations
// layer = no `ticket.replied.customer` subscription. Customer replies on PP
// don't get pushed to Twilio in Phase 3 (agents see them via the iframe's
// reply log fetched via pp-client). Phase 4 may re-add when wiring email loop.

import { subscribe } from '@/pp-client';
import type { TwilioBridgeConfig } from './types';
import { buildTwilioClient } from './twilio-client';
import { onTicketCreated, onTicketRepliedAgent } from './handlers';

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

  subscribe(['ticket.replied.agent'], async (event) => {
    if (event.kind !== 'ticket.replied.agent') return;
    await onTicketRepliedAgent(event, twilio);
  });

  // Phase 3 events NOT subscribed:
  //   - ticket.replied.customer (no Conversations layer; agent reads via iframe)
  //   - ticket.status_changed / ticket.resolved / ticket.closed / ticket.deleted
  //
  // Phase 4 may add ticket.replied.customer for email loop integration.

  console.log(JSON.stringify({
    bridge: 'twilio-flex',
    info: 'registered handlers',
    phase: '3-v2-taskrouter-pivot',
    deploymentId: config.deploymentId,
    workspaceSid: config.workspaceSid,
  }));
}
