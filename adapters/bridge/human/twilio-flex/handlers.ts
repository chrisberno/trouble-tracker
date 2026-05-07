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
  getBridgeMappingByTicketId,
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

  // TTB-17 fix #3+#4: bridge-db is authoritative for ticketId→scope. The
  // intake handler pre-writes the scope from the original request body — but
  // PP often fires its ticket.created webhook BEFORE intake's createTicket
  // call returns, so this bridge handler can race ahead of the prewrite.
  // CCTO-4 confirmed this race observationally on ticket #42: bridge ran with
  // empty scope, prewrite landed seconds later, Twilio resources were already
  // immutable.
  //
  // Fix: retry-on-empty. Read bridge-db; if scope is empty, poll up to 2s in
  // 250ms intervals waiting for intake's prewrite to land. Total added latency
  // only on the race-loss path; race-win path returns on first read.
  //
  // Resolution order:
  //   1. bridge-db pre-write (intake-supplied; race-tolerant via retry)
  //   2. event.ticket.customerScope (in-process synthetic-publish fast-path —
  //      currently always empty in production due to bundler/runtime quirk)
  //   3. '' (no scope binding — degrades to "Unknown" in UI)
  // TTB-17 fix #6: dropped retry-on-empty (PR #22) — observation showed it
  // didn't reliably catch intake's prewrite within 2s (CCTO-4 verified on #43,
  // #45). Cause is irrelevant; we don't race against replica lag any more. We
  // accept that the first read may miss, create Twilio resources with the
  // best-known scope (often empty), and let the backfill block at the end
  // recover via attribute UPDATE calls. Backfill is bundler-agnostic and
  // race-deterministic.
  const prewrittenMapping = await getBridgeMappingByTicketId(ticket.id);
  const effectiveScope =
    (prewrittenMapping?.customerScope && prewrittenMapping.customerScope.trim()) ||
    (ticket.customerScope && ticket.customerScope.trim()) ||
    '';
  console.log(JSON.stringify({
    bridge: 'twilio-flex',
    handler: 'onTicketCreated',
    info: 'scope-resolution',
    ticketId: ticket.id,
    eventScope: ticket.customerScope || '',
    prewrittenScope: prewrittenMapping?.customerScope || '',
    effectiveScope,
  }));

  // TTB-17 fix #8 (Sprint 2.0, 2026-05-07): point Pattern B `profile_url` at
  // the scope-list page resolved by ticketId. CCTO-4 caught a real blast-
  // radius issue: flipping the GLOBAL Flex Admin Active Task URL to
  // `?ticketId={{task.ticketId}}` would break voice/email/legacy tasks (their
  // ticketId is empty/missing → "All scopes / No tickets" right pane =
  // regression). Solution: keep Flex Admin URL as `{{task.profile_url}}` and
  // have the bridge handler set per-Pattern-B-task profile_url here. Voice
  // tasks set their own profile_url via Studio Flow; other task types via
  // their own bridges. Each task type carries its own URL.
  //
  // Canvas Ticket tab (basecamp plugin) is unaffected — it builds its own
  // URL via getBridgeBaseUrl() + /bridge/twilio-flex/ticket/${ticketId}, not
  // task.profile_url.
  //
  // task.attributes.customerScope being empty is now cosmetic-only — the page
  // reads scope from bridge-db using ticketId from the URL param.
  const profileUrl = `https://trouble-ticket-app.vercel.app/bridge/tickets?ticketId=${ticket.id}`;
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
    customerScope: effectiveScope,

    customers: {
      name: ticket.customer.name,
      phone: ticket.customer.phone ?? '',
      organization: effectiveScope,
    },

    origin: effectiveScope,                    // backward-compat for basecamp Email.tsx queue rendering
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
          customerScope: effectiveScope,
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
          customerScope: effectiveScope,
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
      // upsertBridgeMapping uses COALESCE on customer_scope so an earlier
      // intake-side prewrite is preserved if effectiveScope is null/empty here.
      customerScope: effectiveScope || null,
    });

    // TTB-17 fix #7 (Sprint 2.0): no backfill of Twilio attributes. The
    // race-loss backfill (PR #23) never landed reliably across 5 fix attempts
    // — root cause unresolved (timeout, replica lag, log capture loss, or
    // some combination). Pivoted to a structurally cleaner approach: the
    // /bridge/tickets page resolves scope from bridge-db via task.ticketId,
    // which IS reliably populated. task.attributes.customerScope being empty
    // is now cosmetic-only (basecamp Email.tsx queue rendering origin field).
    // See app/bridge/tickets/page.tsx for the resolution path.
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
