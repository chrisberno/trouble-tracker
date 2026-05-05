// adapters/bridge/human/twilio-flex/handlers.ts
// Pure event handlers: receive normalized CoreEvents from pp-client; call
// Twilio APIs via twilio-client; persist mappings via bridge-db.
//
// PHASE 3 v3 / TTB-1 (2026-05-05): RETURNED to Pattern B (Conversations +
// Interactions API). Phase 3 v2's pivot to raw `POST /Tasks` was caused by
// a config.json bug — `conversationsServiceSid` pointed at a non-Flex service
// (IS8bd6c...). Smoke-tested on CCT 2026-05-05 with the corrected service
// (IS91e4bcb...) — agent accept + canvas rendering + bidirectional reply all
// work natively. Sprint doc: `2026-05-05-troubletracker-connie-canvas-handoff
// -target-spec.md`.
//
// Pattern B chain (replaces direct createTask):
//   1. createConversation in CCT default Flex chat service
//   2. addConversationParticipant (customer proxy identity)
//   3. postConversationMessage (first message = ticket subject + description,
//      author = customer proxy identity)
//   4. createInteraction (Flex API; auto-creates the bound TaskRouter task
//      with conversationsSid + flexInteractionSid populated)
//
// Backward compat:
//   - `deploymentId` attribute preserved (load-bearing for task-webhook
//     discriminator gate against legacy NSS PCA tasks)
//   - `origin`, `customerScope`, `name`, `type`, `profile_url` preserved
//     for basecamp Email.tsx queue rendering
//   - bridge-db mapping now persists conversationSid + interactionSid
//     (previously null on Pattern A; needed for downstream addReply path)
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

  // Stable proxy identity for the customer participant in the Twilio
  // Conversation. Per Twilio reply 2026-05-05: web-form intake customers need
  // a proxy identity (no native SMS/WhatsApp ID). Deterministic per-ticket
  // identity so retries are idempotent and the customer participant never
  // collides across tickets.
  const customerProxyIdentity = `connie-customer-ticket-${ticket.id}`;
  const conversationFriendlyName = `Ticket #${ticket.id}: ${ticket.subject}`.slice(0, 256);

  // Task attributes — preserved from Phase 3 v2 for basecamp Email.tsx + the
  // task-webhook discriminator gate. Flex Interactions API auto-populates
  // additional fields (flexInteractionSid, flexInteractionChannelSid,
  // flexChannelInviteSid, conversations.media, taskCreateSource: "interaction",
  // initiatedBy, direction, channelType) — those are NOT set here.
  const taskAttributes = {
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
    customerEmail: ticket.customer.email ?? '',
    customerScope: ticket.customerScope,

    customers: {
      name: ticket.customer.name,
      phone: ticket.customer.phone ?? '',
      organization: ticket.customerScope,
    },

    origin: ticket.customerScope,              // backward-compat for basecamp Email.tsx queue rendering
    timestamp: new Date().toISOString(),
    channel: 'support-ticket',
    conversationsTaskKey: `support_ticket_${ticket.id}`,

    // LOAD-BEARING — discriminator gate in app/api/bridge/twilio-flex/
    // task-webhook/route.ts shorts-circuits any task without this field, OR
    // with a non-matching value. Without this, task.completed events on legacy
    // NSS PCA tasks would call closeTicket against incompatible Postgres IDs.
    deploymentId: twilio.config.deploymentId,
  };

  try {
    // Step 1: Create the Twilio Conversation in the Flex default chat service.
    const conv = await twilio.createConversation(
      {
        friendlyName: conversationFriendlyName,
        attributes: {
          ticketId: ticket.id,
          customerScope: ticket.customerScope,
          deploymentId: twilio.config.deploymentId,
          intakeSource: 'web-form',
        },
      },
      `twilio:conv:${ticket.id}`,
    );

    // Step 2: Add the customer as a chat participant (proxy identity).
    await twilio.addConversationParticipant(
      {
        conversationSid: conv.conversationSid,
        identity: customerProxyIdentity,
        attributes: {
          role: 'customer',
          name: ticket.customer.name,
          email: ticket.customer.email ?? '',
          phone: ticket.customer.phone ?? '',
          customerScope: ticket.customerScope,
        },
      },
      `twilio:participant:${ticket.id}`,
    );

    // Step 3: Drop the first message (ticket subject + description) authored
    // by the customer proxy. This is what the Connie agent canvas thread
    // displays as the inbound from the ticket filer.
    const firstBody = ticket.subject
      ? `${ticket.subject}\n\n${ticket.description}`
      : ticket.description;
    await twilio.postConversationMessage(
      {
        conversationSid: conv.conversationSid,
        body: firstBody,
        author: customerProxyIdentity,
      },
      `twilio:firstmsg:${ticket.id}`,
    );

    // Step 4 (Phase 5, TTB-1): Register a per-conversation webhook for
    // onMessageAdded. When the Connie agent types a reply in the canvas, the
    // message is added to this Conversation; Twilio fires this webhook; our
    // endpoint forwards the reply to PP.app via pp-client.addReply (with
    // source='flex' for loop prevention). Customer-authored messages (Author
    // matches the proxy identity prefix) are filtered out at the endpoint.
    //
    // ticketId in the URL query param avoids a Conversation fetch on each
    // webhook fire — endpoint reads it directly from the URL.
    const iframeBase = new URL(twilio.config.iframeBaseUrl);
    const conversationMessageWebhookUrl =
      `${iframeBase.origin}/api/bridge/twilio-flex/conversation-message?ticketId=${encodeURIComponent(ticket.id)}`;
    await twilio.addConversationWebhook(
      {
        conversationSid: conv.conversationSid,
        url: conversationMessageWebhookUrl,
        filters: ['onMessageAdded'],
        method: 'POST',
      },
      `twilio:convwebhook:${ticket.id}`,
    );

    // Step 5: Create the Flex Interaction. This auto-creates the bound
    // TaskRouter task (with conversationsSid populated) and lands it in the
    // CCT support queue. Priority comes from the workflow + queue config;
    // we pass priority via task attribute for plugin display.
    const interaction = await twilio.createInteraction(
      {
        conversationSid: conv.conversationSid,
        initiatedBy: 'customer',
        channelType: 'chat',
        workflowSid: twilio.config.supportWorkflowSid,
        taskChannelUniqueName: twilio.config.taskChannel,
        taskAttributes: {
          ...taskAttributes,
          // Hint to TaskRouter for prioritization
          priority_number: priorityNum,
        },
      },
      `twilio:interaction:${ticket.id}`,
    );

    await upsertBridgeMapping({
      ticketId: ticket.id,
      interactionSid: interaction.interactionSid,
      conversationSid: conv.conversationSid,
      taskSid: interaction.taskSid,
    });

    await markBridgeKeyProcessed(idempotencyKey);

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      ok: true,
      ticketId: ticket.id,
      conversationSid: conv.conversationSid,
      interactionSid: interaction.interactionSid,
      taskSid: interaction.taskSid,
      taskChannel: twilio.config.taskChannel,
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
