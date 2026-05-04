// adapters/bridge/human/twilio-flex/register.ts
// Wires bridge handlers to pp-client's event dispatch via subscribe().
// Called once at module load by app/api/pp-webhook/route.ts.
//
// Design: small + explicit. No generic event bus; each pp-client event kind
// maps to a single bridge handler. Per brief Task 2: "Keep dispatch logic small
// and explicit; do NOT introduce a generic event bus."

import { subscribe } from '@/pp-client';
import type { TwilioBridgeConfig } from './types';
import { buildTwilioClient } from './twilio-client';
import {
  onTicketCreated,
  onTicketRepliedCustomer,
  onTicketRepliedAgent,
} from './handlers';

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

  // ticket.status_changed / ticket.resolved / ticket.closed / ticket.deleted:
  // Phase 3 takes no Twilio-side action on these. Phase 4 may add (e.g., close
  // the Conversation when ticket hits closed status). Brief explicitly marks
  // onTicketStatusChanged as optional Phase 3.

  console.log(JSON.stringify({
    bridge: 'twilio-flex',
    info: 'registered handlers',
    deploymentId: config.deploymentId,
    workspaceSid: config.workspaceSid,
    conversationsServiceSid: config.conversationsServiceSid,
  }));
}
