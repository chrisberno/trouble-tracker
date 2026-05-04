// adapters/bridge/human/twilio-flex/handlers.ts
// Pure event handlers: receive normalized CoreEvents from pp-client; call
// Twilio APIs via twilio-client; persist mappings via bridge-db.
//
// =========================================================================
// LOOP DISCIPLINE MATRIX (per Phase 4 brief Deliverable #9)
// =========================================================================
// Every potential loop path between PP and Twilio + the mechanism that
// breaks it. If you're modifying this file, verify your change preserves
// EVERY break mechanism below.
//
//   PATH 1: Agent reply → pp-client.addReply(source:'flex')
//             → PP webhook ticket.replied.agent
//             → handlers.onTicketRepliedAgent
//           BREAK: source-tag check; handler observe-only, no Twilio re-write
//
//   PATH 2: Agent reply → pp-client.addReply(source:'flex')
//             → PP automated customer notification email
//             → customer email reply
//             → PP webhook ticket.replied.customer (NO source tag)
//             → handlers.onTicketRepliedCustomer
//             → bridge pushes to Conversation as 'customer' message
//           STATUS: legitimate path (not a loop) — this IS the round-trip
//
//   PATH 3: PP outbound notification email events → bridge
//           BREAK: bridge does NOT subscribe to outbound email events.
//           Pre-execution PP webhook config audit confirms
//           troubletracker_tblapi_webhooks.events covers ONLY:
//           ticket.created, ticket.replied, ticket.status_changed, ticket.deleted
//
//   PATH 4: Bridge.onTicketRepliedCustomer pushes to Conversation
//             → Twilio Conversations onMessageAdded webhook fires
//             → conversations-webhook receiver
//             → would call pp-client.addReply → loop
//           BREAK: receiver skips messages where Author === 'customer'
//           (bridge's own outbound). Plus idempotency on twilioMessageSid.
//
//   PATH 5: Agent reply via iframe customer-reply route (Phase 3 inheritance)
//             → pp-client.addReply(source:'flex')
//           STATUS: same as PATH 1 — source tag breaks the loop
//
//   PATH 6 (ADJACENT, OUT OF SCOPE): Customer replies to PP-automated email
//             → arrives via Twilio email channel inbound
//             → creates a NEW email Task (NOT a TT support_ticket task)
//           BREAK: discriminator gate in task-webhook checks
//           attributes.deploymentId !== 'connie' — these tasks lack
//           deploymentId (or have a different one) → silent 200 + no PP write
//
// =========================================================================
// PHASE 4 (2026-05-04): atomic Conversation+Task pair on ticket.created.
// onTicketCreated now:
//   1. Inserts mapping row with status='pending' BEFORE any Twilio call
//   2. Creates Conversation with uniqueName idempotency token (catches 409)
//   3. Creates Task with conversationSid in attributes
//   4. Compensating delete on Conversation if Task fails
//   5. Reconcile job sweeps stale 'pending' rows (separate cron route)
// =========================================================================

import type { CoreEvent } from '@/pp-client/types';
import type { TwilioClient } from './twilio-client';
import {
  insertPendingMapping,
  updateMappingSid,
  getBridgeMappingByTicketId,
  isBridgeKeyProcessed,
  markBridgeKeyProcessed,
} from './bridge-db';
import { BRIDGE_METADATA } from './types';
import { stripHtmlForBridge } from './html-strip';

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
  const idempotencyKey = `twilio:atomic-pair:${ticket.id}`;

  // Idempotency at the handler level — if we've already processed this event,
  // bail. Reconcile job is the safety net for the post-success-pre-mark window.
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

  // ========================================================================
  // STEP 1 — Insert mapping row with status='pending' BEFORE any Twilio call.
  // Closes the "both Twilio calls succeed but DB write fails" hole per
  // PP-CTO refinement #1. Reconcile job has something to scan against if
  // we crash mid-flight.
  // ========================================================================
  await insertPendingMapping(ticket.id);

  const profileUrl = `${twilio.config.iframeBaseUrl}/${ticket.id}`;
  const priorityNum = PRIORITY_TO_TASKROUTER[ticket.priority] ?? 5;
  const uniqueName = `tt-ticket-${ticket.id}-${twilio.config.deploymentId}`;

  // ========================================================================
  // STEP 2 — Create Conversation with uniqueName idempotency (PP-CTO refinement #2).
  // 409 → fetchByUniqueName → proceed (handled inside createConversation).
  // ========================================================================
  let conversationSid: string;
  try {
    const conversation = await twilio.createConversation(
      {
        friendlyName: `Support: ${sanitizeFriendlyName(ticket.subject).slice(0, 80)}`,
        uniqueName,
        attributes: {
          ticketId: ticket.id,
          deploymentId: twilio.config.deploymentId,
          customerScope: ticket.customerScope,
          customerEmail: ticket.customer.email ?? '',
        },
      },
      `twilio:conversation:${ticket.id}`,
    );
    conversationSid = conversation.sid;
    await updateMappingSid(ticket.id, { conversationSid });
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      step: 'createConversation',
      error: err instanceof Error ? err.message : String(err),
      ticketId: ticket.id,
    }));
    await updateMappingSid(ticket.id, { status: 'failed-conversation-create' });
    throw err;
  }

  // ========================================================================
  // STEP 3 — Create Task with conversationSid baked into attributes.
  // Full legacy parity (per lib/taskrouter.ts:39-64) + Phase 3 NEW fields
  // (deploymentId, customerEmail, customerScope, origin) + Phase 4 NEW
  // conversationSid attribute.
  //
  // Task channel: 'email' (CCTO refinement #1). Phase 3 used 'default' to
  // match legacy; Phase 4 changes to 'email' so basecamp's Email.tsx
  // TaskChannelDefinition renders the native Flex Conversations email-style
  // UI in Task Canvas.
  // ========================================================================
  const attributes = {
    name: `Support Ticket: ${ticket.subject}`,
    type: 'support_ticket',
    skill: 'Support',

    profile_url: profileUrl,

    ticketId: ticket.id,
    title: ticket.subject,
    description: ticket.description,
    urgency: ticket.priority,
    priority: ticket.priority,

    customerName: ticket.customer.name,
    customerPhone: ticket.customer.phone ?? '',
    customerEmail: ticket.customer.email ?? '',
    customerScope: ticket.customerScope,

    customers: {
      name: ticket.customer.name,
      phone: ticket.customer.phone ?? '',
      organization: ticket.customerScope,
    },

    origin: ticket.customerScope,
    timestamp: new Date().toISOString(),
    channel: 'support-ticket',
    channelType: 'support',
    conversationsTaskKey: `support_ticket_${ticket.id}`,
    conversationSid,                              // Phase 4 NEW — links Task to Conversation

    // LOAD-BEARING — discriminator gate in task-webhook/route.ts:87.
    // Without this, post-Phase-3-B3 fire would close legacy Postgres ticket
    // IDs against the TT tenant. CCTO Item 1 from brief v1.2 review.
    deploymentId: twilio.config.deploymentId,
  };

  let taskSid: string;
  try {
    const result = await twilio.createTask(
      {
        workflowSid: twilio.config.supportWorkflowSid,
        // CCTO refinement #1: Phase 4 changes from 'default' → 'email' so
        // basecamp's Email.tsx renders the native Flex Conversations
        // email-style UI in Task Canvas (the email-pattern UX is the whole
        // point of Phase 4).
        taskChannel: 'email',
        friendlyName: sanitizeFriendlyName(`Support Ticket: ${ticket.subject}`),
        priority: priorityNum,
        timeout: 3600,
        attributes,
      },
      `twilio:task:${ticket.id}`,
    );
    taskSid = result.taskSid;
  } catch (err) {
    // ========================================================================
    // STEP 4 — Compensating delete on orphan Conversation. PP-CTO refinement #1.
    // If Task creation fails, the Conversation we just created is orphaned.
    // Delete it (deleteConversation catches 404 silently — already-deleted state).
    // ========================================================================
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      step: 'createTask',
      error: err instanceof Error ? err.message : String(err),
      ticketId: ticket.id,
      orphanConversationSid: conversationSid,
      action: 'compensating delete',
    }));
    await twilio.deleteConversation(conversationSid);
    await updateMappingSid(ticket.id, { status: 'failed-task-create' });
    throw err;
  }

  // ========================================================================
  // STEP 5 — Both Twilio creations succeeded. Mark mapping complete + dedup.
  // ========================================================================
  await updateMappingSid(ticket.id, { taskSid, status: 'complete' });
  await markBridgeKeyProcessed(idempotencyKey);

  console.log(JSON.stringify({
    bridge: 'twilio-flex',
    handler: 'onTicketCreated',
    ok: true,
    ticketId: ticket.id,
    conversationSid,
    taskSid,
    deploymentId: twilio.config.deploymentId,
  }));
}

// ============================================================================
// onTicketRepliedCustomer — PHASE 4 ACTIVE: PP customer reply → Twilio Conversation message
//
// Reactivated in Phase 4 (was deleted in Phase 3 v2 pivot). Customer replies
// on the PP ticket get pushed into the linked Twilio Conversation so the
// agent in Flex Task Canvas sees them inline in the native email-style UI.
//
// Loop prevention: per Loop Discipline Matrix PATH 1 + PATH 5, source-tag
// check skips bridge-originated replies. Plus idempotency on PP reply id.
//
// Defensive: if mapping has null conversationSid (Phase 3-era ticket created
// before Phase 4 atomic-pair pattern), graceful no-op + log per CCTO
// refinement #2.
// ============================================================================

export async function onTicketRepliedCustomer(
  event: Extract<CoreEvent, { kind: 'ticket.replied.customer' }>,
  twilio: TwilioClient,
): Promise<void> {
  // Loop prevention check (Matrix PATH 1/5): skip bridge-originated replies.
  // Defensive — customer replies don't typically carry the flex source tag,
  // but if PP echoes our own write this keeps us out of infinite loops.
  if (event.reply.source === BRIDGE_METADATA.source) {
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      info: 'loop prevention: skipping bridge-originated reply',
      ticketId: event.ticketId,
      replyId: event.reply.id,
    }));
    return;
  }

  const idempotencyKey = `twilio:message:${event.reply.id}`;
  if (await isBridgeKeyProcessed(idempotencyKey)) {
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      info: 'duplicate event skipped',
      ticketId: event.ticketId,
      replyId: event.reply.id,
    }));
    return;
  }

  const mapping = await getBridgeMappingByTicketId(event.ticketId);

  // CCTO refinement #2: defensive null-check for Phase 3-era mappings.
  // Phase 3 tickets exist with conversationSid=null since the v2 pivot
  // dropped Conversations. Customer→agent flow can't push to a null
  // Conversation — log + no-op + return cleanly.
  if (!mapping?.conversationSid) {
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      info: 'pre-Phase-4 mapping; no Conversation linkage — skipping push',
      ticketId: event.ticketId,
      replyId: event.reply.id,
      mappingExists: !!mapping,
    }));
    return;
  }

  try {
    // HTML-strip the body before posting to Conversation (Phase 4 D8).
    // event.reply.body already has html-to-text applied by pp-client's
    // event-mapper (Refinement #1 source-tag transit), but we run our
    // own strip again for the bridge-specific config (preserve newlines,
    // drop links/images explicitly).
    const cleanBody = stripHtmlForBridge(event.reply.body);

    const result = await twilio.postConversationMessage(
      {
        conversationSid: mapping.conversationSid,
        body: cleanBody,
        author: 'customer',
      },
      idempotencyKey,
    );

    await markBridgeKeyProcessed(idempotencyKey);

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      ok: true,
      ticketId: event.ticketId,
      replyId: event.reply.id,
      messageSid: result.messageSid,
      conversationSid: result.conversationSid,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketRepliedCustomer',
      error: err instanceof Error ? err.message : String(err),
      ticketId: event.ticketId,
      replyId: event.reply.id,
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
