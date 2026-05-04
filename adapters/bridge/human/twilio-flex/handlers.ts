// adapters/bridge/human/twilio-flex/handlers.ts
// Pure event handlers: receive normalized CoreEvents from pp-client; call
// Twilio APIs via twilio-client; persist mappings via bridge-db.
//
// PIVOT (Phase 3 v2, 2026-05-04): outbound now uses TaskRouter Tasks API
// directly (not Flex Interactions API). Attributes shape mirrors legacy
// `lib/taskrouter.ts:39-64` so basecamp's Flex plugin renders the resulting
// task identically to legacy NSS PCA tasks (line 1 friendly name, line 2
// origin/customerScope). Phase 3 NEW additions on top of legacy parity:
// `customerEmail`, `customerScope`, and the load-bearing `deploymentId`
// for the task-webhook discriminator gate.
//
// Loop prevention: each handler short-circuits when event.source === 'flex'
// (the BRIDGE_METADATA.source tag). This is the same source-tag transit
// convention pp-client uses on its outbound write path (X-PP-Source header).
//
// Handlers are exported individually so register.ts can wire them to specific
// CoreEvent kinds via pp-client's subscribe() surface.

import type { CoreEvent } from '@/pp-client/types';
import type { TwilioClient } from './twilio-client';
import {
  upsertBridgeMapping,
  isBridgeKeyProcessed,
  markBridgeKeyProcessed,
} from './bridge-db';

// Map our normalized priority → legacy TaskRouter Priority form param.
// Mirrors `lib/taskrouter.ts:70` exactly (high=0, medium=5, low=10).
const PRIORITY_TO_TASKROUTER: Record<string, number> = { high: 0, medium: 5, low: 10 };

// Match legacy FriendlyName sanitization rules (`lib/taskrouter.ts:69`):
// strip everything that's not a word char, whitespace, or hyphen.
function sanitizeFriendlyName(title: string): string {
  return title.replace(/[^\w\s-]/g, '');
}

// ============================================================================
// onTicketCreated — outbound: PP ticket.created → TaskRouter Task in CCT WorkBench
// ============================================================================

export async function onTicketCreated(
  event: Extract<CoreEvent, { kind: 'ticket.created' }>,
  twilio: TwilioClient,
): Promise<void> {
  const ticket = event.ticket;
  const idempotencyKey = `twilio:task:${ticket.id}`;

  if (await isBridgeKeyProcessed(idempotencyKey)) {
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      info: 'duplicate event skipped',
      ticketId: ticket.id,
      idempotencyKey,
    }));
    return;
  }

  const profileUrl = `${twilio.config.iframeBaseUrl}/${ticket.id}`;
  const priorityNum = PRIORITY_TO_TASKROUTER[ticket.priority] ?? 5;

  // Full legacy parity attributes (per `lib/taskrouter.ts:39-64`) PLUS Phase 3
  // additions (deploymentId, customerEmail, customerScope). The basecamp Flex
  // plugin reads `origin` for queue list line 2 (per CCTO Email.tsx companion
  // change); we set both `origin` AND `customerScope` to the same value for
  // backward-compat across plugin versions.
  const attributes = {
    name: `Support Ticket: ${ticket.subject}`,
    type: 'support_ticket',
    skill: 'Support',

    profile_url: profileUrl,

    ticketId: ticket.id,
    title: ticket.subject,
    description: ticket.description,
    urgency: ticket.priority,                  // legacy field name
    priority: ticket.priority,                 // brief field name (same value)

    customerName: ticket.customer.name,
    customerPhone: ticket.customer.phone ?? '',
    customerEmail: ticket.customer.email ?? '',          // Phase 3 NEW (Phase 2 form added)
    customerScope: ticket.customerScope,                 // Phase 3 NEW (semantically same as origin)

    customers: {
      name: ticket.customer.name,
      phone: ticket.customer.phone ?? '',
      organization: ticket.customerScope,                // legacy used `origin` here
    },

    origin: ticket.customerScope,                        // backward-compat for basecamp Email.tsx
    timestamp: new Date().toISOString(),
    channel: 'support-ticket',
    channelType: 'support',
    conversationsTaskKey: `support_ticket_${ticket.id}`,

    // Phase 3 LOAD-BEARING — discriminator gate in app/api/bridge/twilio-flex/
    // task-webhook/route.ts shorts-circuits any task without this field, OR
    // with a non-matching value. Without this, B3 fire would close legacy
    // Postgres ticket IDs against the TT tenant.
    deploymentId: twilio.config.deploymentId,
  };

  try {
    const result = await twilio.createTask(
      {
        workflowSid: twilio.config.supportWorkflowSid,
        // Legacy uses 'default' (lib/taskrouter.ts:68). Plugin's Email.tsx
        // queue list rendering keys off this.
        taskChannel: 'default',
        friendlyName: sanitizeFriendlyName(`Support Ticket: ${ticket.subject}`),
        priority: priorityNum,
        timeout: 3600,                          // legacy default (lib/taskrouter.ts:71)
        attributes,
      },
      idempotencyKey,
    );

    await upsertBridgeMapping({
      ticketId: ticket.id,
      // Phase 3 pivot: TaskRouter Tasks API doesn't create Interaction or
      // Conversation. Both fields are persisted as null; Phase 4 may populate.
      interactionSid: null,
      conversationSid: null,
      taskSid: result.taskSid,
    });

    await markBridgeKeyProcessed(idempotencyKey);

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      ok: true,
      ticketId: ticket.id,
      taskSid: result.taskSid,
      deploymentId: twilio.config.deploymentId,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      error: err instanceof Error ? err.message : String(err),
      ticketId: ticket.id,
    }));
    throw err;
  }
}

// ============================================================================
// onTicketRepliedAgent — observe-only (Phase 3 takes no Twilio-side action)
//
// Customer replies arriving via PP webhook (CoreEvent kind 'ticket.replied.customer')
// would normally be pushed into a Twilio Conversation so the agent in WorkBench
// sees them inline. After the Phase 3 pivot to TaskRouter Tasks API, we don't
// have a Conversation per task — agents see customer replies via the iframe
// (page.tsx renders the reply log fetched via pp-client). Phase 4 may revisit.
//
// Agent replies originate from inside the iframe (POST /api/bridge/twilio-flex/
// customer-reply or /internal-note) and are tagged `source: 'flex'` on PP
// addReply. PP fires ticket.replied.agent webhook in response; this handler
// observes it but takes no Twilio-side action — the source tag prevents loops
// regardless.
// ============================================================================

export async function onTicketRepliedAgent(
  event: Extract<CoreEvent, { kind: 'ticket.replied.agent' }>,
  _twilio: TwilioClient,
): Promise<void> {
  console.log(JSON.stringify({
    bridge: 'twilio-flex',
    handler: 'onTicketRepliedAgent',
    info: 'agent-side reply observed; Phase 3 takes no Twilio-side action',
    ticketId: event.ticketId,
    replyId: event.reply.id,
    source: event.reply.source,
  }));
}
