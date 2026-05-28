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

import type { CoreEvent, Ticket, Reply, DeploymentConfig } from '@/pp-client/types';
import { getTicket, reopenTicket } from '@/pp-client';
import type { TwilioClient } from './twilio-client';
import {
  upsertBridgeMapping,
  tryClaimBridgeKey,
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

  // Atomic claim — INSERT ... ON CONFLICT DO NOTHING RETURNING. Closes the
  // race window between /api/intake's after()-dispatched run and PP's
  // ticket.created webhook backstop (~5-10s later) that could otherwise
  // both enter Pattern B and create duplicate Twilio resources. Pre-PR
  // check+mark was non-atomic with mark-at-exit, leaving a 700-1500ms
  // race window equal to Pattern B duration. See bridge-db.ts tryClaimBridgeKey
  // for the doctrine.
  if (!(await tryClaimBridgeKey(idempotencyKey))) {
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'onTicketCreated',
      info: 'duplicate event skipped',
      ticketId: ticket.id,
      idempotencyKey,
    }));
    return;
  }

  // Scope resolution chain — TTB-17 history + 2026-05-15 status:
  //
  // Resolution order:
  //   1. bridge-db pre-write (intake-supplied; web-form/handler.ts calls
  //      prewriteBridgeMappingScope right after createTicket).
  //   2. event.ticket.customerScope (parsed from PP's ticket.created
  //      webhook payload). UNRELIABLE in production — verified
  //      2026-05-15 (ticket #93) that readCustomField returns undefined
  //      even with correct customFieldIds. PP's ticket.created webhook
  //      payload does not carry custom_fields in any of the 4 shapes
  //      readCustomField handles. This slot remains defensive-only.
  //   3. '' (no scope binding) — defensive fallback.
  //
  // Race-handling architecture (2026-05-15, post-#93-smoke PR):
  //
  // The race-loss path (PP webhook fires before intake's prewrite lands)
  // is now closed at the SOURCE side via in-process dispatch from
  // /api/intake/route.ts. handleWebFormIntake returns a constructed
  // ticket.created CoreEvent; the intake route schedules
  // dispatchTicketCreated() via next/server's after(), which calls THIS
  // handler with scope already known from the intake body. Pattern B
  // chain runs out-of-band in the same Vercel function lifetime.
  //
  // PP's ticket.created webhook fires ~5-10s later as the
  // eventual-consistency backstop. This handler re-enters with the SAME
  // ticketId → SAME idempotency key (`twilio:task:<ticketId>`, line ~58)
  // → tryClaimBridgeKey returns false (atomic check-and-claim via
  // INSERT ... ON CONFLICT DO NOTHING RETURNING) → short-circuit. The
  // "duplicate event skipped" log line is the load-bearing safety net
  // verification (smoke #4 gate).
  //
  // Partial-failure trade-off (honest): the atomic claim is set at handler
  // entry, before Pattern B executes. If Pattern B throws midway, the
  // backstop will still short-circuit on the claim — so partial Twilio
  // resources (conv created, no task) become orphans rather than getting
  // retried. The OLD (pre-PR) non-atomic mark-at-exit design would have
  // retried, but with no Twilio API-level idempotency token (verified
  // twilio-client.ts:50 — keys logged, not sent in headers), retry would
  // create DUPLICATE resources instead of recovering. Atomic-claim
  // chooses orphans over duplicates. Proper fix is per-step Twilio
  // idempotency headers — out of scope for this PR; follow-up backlog.
  //
  // Historical context: TTB-17 fix #3/#4 added the bridge-db prewrite to
  // handle the race; fix #6 (PR #22) dropped retry-on-empty; fix #7 (PR
  // #23) dropped attribute backfill — both retired on the (then-correct)
  // assumption that task.attributes.customerScope was cosmetic-only.
  // basecamp bc88f9a7 (2026-05-15, SupportTicket.tsx) made it load-bearing
  // again for queue-line rendering. The in-process-dispatch fix above
  // closes the race without re-introducing the retry/backfill patterns
  // TTB-17 deliberately removed.
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
  // task.attributes.customerScope is LOAD-BEARING again as of 2026-05-15
  // (basecamp bc88f9a7 SupportTicket.tsx queue-line render reads
  // task.attributes directly). Both surfaces — /bridge/tickets page (reads
  // bridge-db via ticketId) and the basecamp plugin queue-line render
  // (reads task.attributes) — now have a reliable source via the
  // in-process dispatch from /api/intake (scope known from intake body).
  // PP webhook backstop covers any in-process failure via idempotent retry.
  // See scope-resolution comment block above for the full doctrine.
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

    // TTB-17 fix #7 (Sprint 2.0): no backfill of Twilio attributes — the
    // backfill (PR #23) never landed reliably across 5 fix attempts and
    // was retired. Replaced by /bridge/tickets reading scope from bridge-db.
    //
    // 2026-05-15: the race-loss path that previously produced empty scope
    // on task attributes is now closed at the source via in-process
    // dispatch from /api/intake (see scope-resolution comment at the top
    // of this handler). Backfill remains unnecessary.
    //
    // No mark needed at this point — the idempotency key was claimed
    // atomically at the TOP of the handler via tryClaimBridgeKey. PP's
    // subsequent webhook fire will hit the claim check and short-circuit
    // with `info: 'duplicate event skipped'` (smoke #4 verification gate).

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

// ============================================================================
// onTicketRepliedCustomer — Sprint 4.0: surface a customer reply in Flex
//
// Fires when PP emits `ticket.replied.customer` — which happens both when a
// customer types into the canvas iframe AND when the email round-trip lands
// (the /api/email-inbound webhook calls addReply with source='email', PP
// classifies it as customer-authored, fires ticket.replied.customer).
//
// Action: set task.attributes.ticketHasNewReply=true + lastCustomerReplyAt
// on the assigned Twilio task. The basecamp ticket-reply-notification feature
// (Task 3b) reads the attribute via the Flex SDK's task-update push and
// renders a notification + canvas badge to the assigned agent.
//
// Loop prevention: not needed at this layer. PP only fires
// ticket.replied.customer when the author is the customer (or, via
// /api/email-inbound, when source='email'). Agent replies fire
// ticket.replied.agent which is handled by onTicketRepliedAgent above.
//
// Gated upstream in register.ts on deployment.channels.flexCustomerReplyNotification.enabled.
// ============================================================================

export async function onTicketRepliedCustomer(
  event: Extract<CoreEvent, { kind: 'ticket.replied.customer' }>,
  twilio: TwilioClient,
  deployment?: DeploymentConfig,
): Promise<void> {
  await bumpTaskAttributesForReply(event.ticketId, event.reply, twilio, 'onTicketRepliedCustomer', deployment);
}

// Sprint 4.0 Task 7 (2026-05-27): email-sourced customer replies arrive as
// ticket.replied.AGENT events from PP, NOT ticket.replied.customer. Discovered
// during partial smoke on ticket #100 (replyId=65). Root cause: pp-client.addReply
// uses staff-auth API → Perfex attaches a staff_id → fires .agent webhook.
// /api/email-inbound's design comment (line ~78) assumed PP would fire .customer
// — that assumption is empirically wrong for our Foundation 50k tier.
//
// This handler subscribes to ticket.replied.agent + filters to reply.source ===
// 'email' (set by /api/email-inbound on addReply). Treats those as customer
// replies for the Flex notification path. Non-email-sourced .agent replies are
// genuine agent canvas replies and skip this handler.
export async function onTicketRepliedAgentFromEmail(
  event: Extract<CoreEvent, { kind: 'ticket.replied.agent' }>,
  twilio: TwilioClient,
  deployment?: DeploymentConfig,
): Promise<void> {
  if (event.reply.source !== 'email') {
    // Not an email-sourced reply — genuine agent canvas reply. Skip; the
    // onTicketRepliedAgent observer handles those.
    return;
  }
  await bumpTaskAttributesForReply(event.ticketId, event.reply, twilio, 'onTicketRepliedAgentFromEmail', deployment);
}

// Shared helper for customer replies. Two paths:
//   1. LIVE task  → read-merge-write the new-reply markers (the S5 bump). UNCHANGED.
//   2. NO live task (completed/canceled/gone) → S6 reopen: reopen the ticket and
//      mint a fresh task so the reply actually reaches an agent. Reopens are the
//      COMMON case for async email round-trips, not the edge.
// Called by onTicketRepliedCustomer (native) and onTicketRepliedAgentFromEmail
// (email-sourced, the production path). deployment is required to take the
// reopen path (pp-client getTicket/reopenTicket); absent = pre-S6 behavior.
async function bumpTaskAttributesForReply(
  ticketId: string,
  reply: Reply,
  twilio: TwilioClient,
  handlerName: string,
  deployment?: DeploymentConfig,
): Promise<void> {
  const mapping = await getBridgeMappingByTicketId(ticketId);

  // One getTaskAttributes call decides liveness AND serves as the read side of
  // the live-task read-merge-write below.
  let current: Record<string, unknown> | null = null;
  let assignmentStatus: string | undefined;
  let workerSid: string | undefined;
  let liveTask = false;
  if (mapping?.taskSid) {
    try {
      const res = await twilio.getTaskAttributes(mapping.taskSid);
      current = res.attributes;
      assignmentStatus = res.assignmentStatus;
      workerSid = res.workerSid;
      // Terminal tasks can't be updated and aren't in any agent's Flex client.
      liveTask = assignmentStatus !== 'completed' && assignmentStatus !== 'canceled';
    } catch {
      // GET failed (task deleted / 404 after TaskRouter GC) → not live.
      liveTask = false;
    }
  }

  // --- LIVE task: existing S5 bump (read-merge-write). Behavior UNCHANGED. ---
  if (mapping?.taskSid && liveTask && current) {
    try {
      const merged: Record<string, unknown> = {
        ...current,
        ticketHasNewReply: true,
        lastCustomerReplyAt: new Date().toISOString(),
        lastCustomerReplyId: reply.id,
      };
      await twilio.updateTaskAttributes({
        taskSid: mapping.taskSid,
        attributes: merged,
      });
      console.log(JSON.stringify({
        bridge: 'twilio-flex',
        handler: handlerName,
        ok: true,
        action: 'bumped-live-task',
        ticketId,
        replyId: reply.id,
        taskSid: mapping.taskSid,
        assignmentStatus,
        workerSid,
        replySource: reply.source ?? 'customer-direct',
      }));
    } catch (err) {
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        handler: handlerName,
        warning: 'attribute bump failed; reply still visible in iframe',
        ticketId,
        replyId: reply.id,
        taskSid: mapping.taskSid,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    return;
  }

  // --- NO live task: S6 reopen path. ---
  if (!deployment) {
    // Pre-S6 fallback: reply stays durable in PP, no proactive surfacing.
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: handlerName,
      info: 'no live task and reopen disabled (no deployment config); reply durable in PP only',
      ticketId,
      replyId: reply.id,
    }));
    return;
  }
  try {
    await createReopenTask(ticketId, reply, twilio, deployment, mapping?.customerScope ?? null);
  } catch (err) {
    console.warn(JSON.stringify({
      bridge: 'twilio-flex',
      handler: handlerName,
      warning: 'reopen task creation failed; reply still durable in PP',
      ticketId,
      replyId: reply.id,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// S6 (2026-05-28): reopen path. Deliberately SELF-CONTAINED — mirrors
// onTicketCreated's Pattern B chain rather than sharing an extracted helper, so
// the proven create path stays byte-for-byte untouched (zero-regression mandate).
// DRY-up is an S6 fast-follow. Idempotency keys are suffixed with reopen+replyId
// so they never collide with the original create's keys for the same ticketId.
async function createReopenTask(
  ticketId: string,
  reply: Reply,
  twilio: TwilioClient,
  deployment: DeploymentConfig,
  scopeFromMapping: string | null,
): Promise<void> {
  const replyId = String(reply.id);

  // Atomic claim — a given reply reopens at most once even on webhook double-fire.
  // Same orphan-over-duplicate trade-off as onTicketCreated's claim-at-entry.
  const claimKey = `twilio:reopen:${ticketId}:${replyId}`;
  if (!(await tryClaimBridgeKey(claimKey))) {
    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      handler: 'createReopenTask',
      info: 'duplicate reopen skipped',
      ticketId,
      replyId,
    }));
    return;
  }

  const ticket: Ticket = await getTicket(ticketId, deployment);

  // Scope: bridge-db is authoritative (TTB-17 — PP GET doesn't return
  // custom_fields). Prefer the mapping's scope, fall back to the ticket's.
  const effectiveScope =
    (scopeFromMapping && scopeFromMapping.trim()) ||
    (ticket.customerScope && ticket.customerScope.trim()) ||
    '';

  // Reopen the PP ticket ONLY if actually closed — don't downgrade a ticket
  // that's still open/in_progress/waiting.
  if (ticket.status === 'closed') {
    await reopenTicket(ticketId, deployment);
  }

  const profileUrl = `https://trouble-ticket-app.vercel.app/bridge/tickets?ticketId=${ticketId}`;
  const priorityNum = PRIORITY_TO_TASKROUTER[ticket.priority] ?? 5;
  const customerProxyIdentity = `connie-customer-ticket-${ticketId}`;
  const conversationFriendlyName = `Ticket #${ticketId} (reopened): ${ticket.subject}`.slice(0, 256);

  // Mirror onTicketCreated's load-bearing attribute set EXACTLY + reopen markers.
  const taskAttributes = {
    name: `Support Ticket: ${ticket.subject}`,
    type: 'support_ticket',
    skill: 'Support',
    profile_url: profileUrl,
    ticketId,
    title: ticket.subject,
    description: ticket.description,
    urgency: ticket.priority,
    priority: ticket.priority,
    customerName: ticket.customer.name,
    customerPhone: ticket.customer.phone ?? '',
    customerEmail: ticket.customer.email ?? '',
    customerScope: effectiveScope,
    customers: {
      name: ticket.customer.name,
      phone: ticket.customer.phone ?? '',
      organization: effectiveScope,
    },
    origin: effectiveScope,
    timestamp: new Date().toISOString(),
    channel: 'support-ticket',
    // Unique per reopen — never collides with the original task's key.
    conversationsTaskKey: `support_ticket_${ticketId}_reopen_${replyId}`,
    deploymentId: twilio.config.deploymentId,
    // S6 reopen markers (fast-follow renders a badge from `reopen`).
    reopen: true,
    reopenedAt: new Date().toISOString(),
    ticketHasNewReply: true,
    lastCustomerReplyAt: new Date().toISOString(),
    lastCustomerReplyId: reply.id,
  };

  // Pattern B chain (mirrors onTicketCreated). Reopen-suffixed idempotency keys.
  const conv = await twilio.createConversation(
    {
      friendlyName: conversationFriendlyName,
      attributes: {
        ticketId,
        customerScope: effectiveScope,
        deploymentId: twilio.config.deploymentId,
        intakeSource: 'email-reopen',
      },
    },
    `twilio:conv:reopen:${ticketId}:${replyId}`,
  );

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
    `twilio:participant:reopen:${ticketId}:${replyId}`,
  );

  const firstBody = reply.body?.trim()
    ? `Customer reply (ticket reopened):\n\n${reply.body}`
    : `Ticket #${ticketId} was reopened by a customer reply.`;
  await twilio.postConversationMessage(
    {
      conversationSid: conv.conversationSid,
      body: firstBody,
      author: customerProxyIdentity,
    },
    `twilio:firstmsg:reopen:${ticketId}:${replyId}`,
  );

  const iframeBase = new URL(twilio.config.iframeBaseUrl);
  const conversationMessageWebhookUrl =
    `${iframeBase.origin}/api/bridge/twilio-flex/conversation-message?ticketId=${encodeURIComponent(ticketId)}`;
  await twilio.addConversationWebhook(
    {
      conversationSid: conv.conversationSid,
      url: conversationMessageWebhookUrl,
      filters: ['onMessageAdded'],
      method: 'POST',
    },
    `twilio:convwebhook:reopen:${ticketId}:${replyId}`,
  );

  const interaction = await twilio.createInteraction(
    {
      conversationSid: conv.conversationSid,
      initiatedBy: 'customer',
      channelType: 'chat',
      workflowSid: twilio.config.supportWorkflowSid,
      taskChannelUniqueName: twilio.config.taskChannel,
      taskAttributes: {
        ...taskAttributes,
        priority_number: priorityNum,
      },
    },
    `twilio:interaction:reopen:${ticketId}:${replyId}`,
  );

  // Re-point the bridge mapping to the NEW task (upsert overwrites task_sid).
  await upsertBridgeMapping({
    ticketId,
    interactionSid: interaction.interactionSid,
    conversationSid: conv.conversationSid,
    taskSid: interaction.taskSid,
    customerScope: effectiveScope || null,
  });

  console.log(JSON.stringify({
    bridge: 'twilio-flex',
    handler: 'createReopenTask',
    ok: true,
    action: 'reopened',
    ticketId,
    replyId,
    conversationSid: conv.conversationSid,
    interactionSid: interaction.interactionSid,
    taskSid: interaction.taskSid,
    customerScope: effectiveScope,
    ppReopened: ticket.status === 'closed',
  }));
}
