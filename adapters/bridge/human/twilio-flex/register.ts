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
import type { DeploymentConfig } from '@/pp-client/types';
import type { TwilioBridgeConfig } from './types';
import { buildTwilioClient } from './twilio-client';
import { onTicketCreated, onTicketRepliedAgent, onTicketRepliedCustomer } from './handlers';

let registered = false;

// Sprint 4.0: register now optionally accepts the full DeploymentConfig so it
// can read channels.flexCustomerReplyNotification.enabled. Backward compatible:
// callers passing only the TwilioBridgeConfig keep prior behavior (no customer-
// reply subscriber). The pp-webhook route passes the deployment alongside.
export function register(config: TwilioBridgeConfig, deployment?: DeploymentConfig): void {
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

  // Sprint 4.0 — ticket.replied.customer: gated on
  // deployment.channels.flexCustomerReplyNotification.enabled. When true, fires
  // a TaskRouter task attribute bump (ticketHasNewReply=true) which the basecamp
  // ticket-reply-notification feature reads to surface a toast + canvas badge.
  // When the flag is false or the deployment block is absent, the subscriber
  // is not registered — pre-S4.0 behavior preserved.
  const flexReplyEnabled =
    deployment?.channels?.flexCustomerReplyNotification?.enabled === true;
  if (flexReplyEnabled) {
    subscribe(['ticket.replied.customer'], async (event) => {
      if (event.kind !== 'ticket.replied.customer') return;
      await onTicketRepliedCustomer(event, twilio);
    });
  }

  // Phase 3 events still NOT subscribed:
  //   - ticket.status_changed / ticket.resolved / ticket.closed / ticket.deleted

  console.log(JSON.stringify({
    bridge: 'twilio-flex',
    info: 'registered handlers',
    phase: '4-customer-reply-bump',
    deploymentId: config.deploymentId,
    workspaceSid: config.workspaceSid,
    flexCustomerReplyNotificationEnabled: flexReplyEnabled,
  }));
}
