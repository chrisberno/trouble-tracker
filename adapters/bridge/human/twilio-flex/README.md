# adapters/bridge/human/twilio-flex

Twilio Flex bridge adapter — the first concrete bridge in the Onreb portfolio.
Lives at `adapters/bridge/human/twilio-flex/` per Manifesto v2.2 layout
(`human/` segment maps to `resolverType: "human"` per the Bridge Contract).

**Phase 3 → Phase 4 of TroubleTracker Sprint 1.0** (ONR-77). Briefs at
`vault/projects/trouble-tracker-app/technical/dev-logs/traycer-brief-phase-3.md` (v1.3, shipped) and `traycer-brief-phase-4.md` (v1.0 official, shipped).

> **Phase 4 (2026-05-04):** Email-pattern UX for trouble tickets. Bridge
> creates a Twilio Conversation alongside each Task on `ticket.created`
> (atomic-pair pattern with mapping-row-first + uniqueName idempotency +
> compensating delete on Task fail). Customer replies on PP push into the
> linked Conversation (so Task Canvas in Flex shows them inline via the
> native email UI). Agent replies in Flex composer fire the Conversations
> onMessageAdded webhook → bridge writes to PP with `source: 'flex'` for
> loop prevention. New customer-profile iframe at
> `/bridge/twilio-flex/customer-profile/[email]` ready for Phase 8a cutover
> when eCRM container URL template flips from per-ticket → per-customer.
>
> **Phase 3 v2 pivot history (2026-05-04):** Phase 3 outbound originally
> used Flex Interactions API; pivoted to TaskRouter Tasks API directly
> after the former rejected our auth + body on the CCT account. Phase 3
> shipped iframe-driven agent UX (status flip / customer reply / internal
> note in the per-ticket iframe). Phase 4 keeps those iframe routes intact
> (still functional) AND adds the Conversations layer + customer-profile
> iframe. Both Phase 3 + Phase 4 surfaces co-exist; Phase 8a cutover
> determines which one drives the eCRM container.

---

## What it does

Round-trips PP.app tickets through Twilio Flex so live agents can resolve
them inside Twilio WorkBench using Conversations as the message substrate.

### Bridge metadata (declared per Manifesto v2.2)

```ts
export const BRIDGE_METADATA = {
  resolverType: 'human',
  iframeUrlPattern: '/bridge/twilio-flex/ticket/{id}',
  source: 'flex',
} as const;
```

- **`resolverType: 'human'`** — agents work tickets in WorkBench; this is not an automated bridge
- **`iframeUrlPattern`** — path Flex's enhanced_crm_container loads when a Task is accepted
- **`source: 'flex'`** — opaque tag on ALL bridge writes; loop prevention key

---

## Phase 3 flows (1 outbound, 1 inbound — iframe-driven agent UX)

### Outbound (PP → Twilio)

```
PP ticket.created webhook
  → pp-client emits CoreEvent { kind: 'ticket.created' }
  → handlers.onTicketCreated
  → twilio-client.createTask(workspace + workflow + attributes)
  → Twilio creates: Task in CCT WorkBench (TaskRouter routes to Support queue)
  → bridge-db.upsertBridgeMapping(ticketId → taskSid; interaction/conversation null)
```

### Inbound (Twilio → PP)

```
Agent completes Task in WorkBench
  → Twilio TaskRouter Workspace event-callback fires (post-B3-go-live)
  → /api/bridge/twilio-flex/task-webhook
  → verifyTwilioSignature
  → DISCRIMINATOR GATE (load-bearing): short-circuit if attributes.deploymentId !== 'connie'
  → on EventType=task.completed: pp-client.closeTicket(ticketId)
  → PP fires ticket.status_changed webhook (Phase 3 takes no further action)
```

### Iframe-driven agent UX (replaces native Conversation reply)

When an agent accepts a Task in WorkBench, the enhanced_crm_container loads
`task.attributes.profile_url` → `/bridge/twilio-flex/ticket/{id}` (server-side
rendered via pp-client). The iframe has three action buttons:

```
┌──────────────────────────────────────────────────────┐
│ Update status     → /api/bridge/twilio-flex/status-flip   │
│   (open / in_progress / closed)                          │
├──────────────────────────────────────────────────────┤
│ Reply to customer → /api/bridge/twilio-flex/customer-reply │
│   (POST → pp-client.addReply isInternal=false source=flex) │
├──────────────────────────────────────────────────────┤
│ Add internal note → /api/bridge/twilio-flex/internal-note  │
│   (POST → pp-client.addReply isInternal=true source=flex)  │
└──────────────────────────────────────────────────────┘
```

All three POST through bridge endpoints (server-side, server holds the PP token).
Browser never sees PP credentials.

## Phase 4 deferred (out of Phase 3 scope)

Brief originally specified two additional flows (PP customer-side replies →
Twilio Conversation messages, and Conversations webhook → pp-client.addReply
for agent messages typed in WorkBench's native UI). After the TaskRouter Tasks
API pivot, those flows depend on a Conversation per task that doesn't exist
in Phase 3. Deferred to Phase 4 (which already owns the customer email loop +
bidirectional reply with HTML stripping + loop prevention).

Forward-compat hooks already in place:
- `twilio-client.postConversationMessage()` defined but unused
- `bridge-db.BridgeMapping` schema retains nullable `interactionSid` +
  `conversationSid` columns
- `getBridgeMappingByConversationSid()` defined but unused
- `deployments/connie/config.json` retains `conversationsServiceSid`
  (`IS8bd6c045...`)
- Twilio Conversations Service post-webhook URL still configured (per ledger
  row B2) — currently a 404 receiver (no Conversations exist on the new
  TT-dedicated service); harmless until Phase 4 lights it up

---

## The discriminator gate (READ THIS BEFORE TOUCHING task-webhook)

The TaskRouter Workspace event-callback fires for **every** task on the
Workspace, including legacy production tasks created by `lib/taskrouter.ts`.
Legacy tasks ALSO carry a `ticketId` attribute (a Postgres-backed legacy ID,
NOT a PP ticket ID).

**The discriminator is `attributes.deploymentId`, NOT presence of `ticketId`.**

Bridge-created Interactions set `deploymentId: <currentDeployment.id>` per
`handlers.onTicketCreated`. Legacy `lib/taskrouter.ts` doesn't.

The gate MUST be the FIRST check in the task-webhook handler, BEFORE any
pp-client call. CCTO caught this during brief review v1.2; without the gate,
B3-fire (the go-live trigger) would call `pp-client.closeTicket(<legacy-postgres-id>)`
against the TT tenant — best case error, worst case accidental write to an
unrelated PP record.

Future hardening (Phase 4+): TaskSid-based allowlist via
`twilio_bridge_mappings.task_sid` lookup. Not required for Phase 3.

---

## Loop prevention — source-tag transit

Every bridge → PP write tags `source: 'flex'`. PP fires a webhook back when
the reply lands; the resulting CoreEvent carries `event.reply.source`. Bridge
handlers short-circuit on `source === 'flex'` (defensive — `ticket.replied.agent`
events for flex-tagged replies are observed but not echoed back to Twilio).

```
Agent reply in Flex
  → conversations-webhook
  → pp-client.addReply(..., source: 'flex')
  → PP fires ticket.replied.agent webhook
  → CoreEvent.reply.source === 'flex'
  → handlers.onTicketRepliedAgent observes; no Twilio re-write; loop broken
```

The same discipline protects internal-note writes (also tagged `source: 'flex'`).

---

## Twilio API surface used (Phase 3)

- **TaskRouter Tasks API** (`taskrouter.twilio.com/v1/Workspaces/<WS...>/Tasks`) — POST creates a Task on the Workspace; Workflow routes to Support queue (production pattern in legacy `lib/taskrouter.ts:75-85` + Connie's basecamp-v26.02 `taskrouter.private.js:194-213`)
- **TaskRouter Workspace event-callback** (configured via `taskrouter.twilio.com/v1/Workspaces/<WS...>` PUT — ledger row B3) — fires on `task.completed` / `task.canceled`

Phase 4 forward-compat (defined in `twilio-client.ts` but not called):
- **Conversations API** (`conversations.twilio.com/v1/Services/<IS...>/Conversations/<CH...>/Messages`) — `postConversationMessage()` reserved for Phase 4 customer email loop
- **Conversations Service-level webhook** (configured via Configuration/Webhooks endpoint — ledger row B2 already attached) — currently dormant (no Conversations exist on the new TT-dedicated service); Phase 4 will activate

All Twilio writes carry an idempotency key tracked in `twilio_bridge_idempotency`
(separate from pp-client's idempotency table to keep substrate boundaries clean).

---

## Configuration

Bridge consumes `TwilioBridgeConfig` (see `types.ts`). Built per-deployment
in `deployments/<id>/index.ts`.

Connie deployment values (per `deployments/connie/config.json`):

| Field | Value |
|---|---|
| `accountSid` | `process.env.TWILIO_RTC_ACCOUNT_SID` (CCT account) |
| `authToken` | `process.env.TWILIO_RTC_AUTH_TOKEN` |
| `workspaceSid` | `WSfe43abb4378f0f1e2ebb98877c03bd1d` (CCT Connie Care Team) |
| `supportWorkflowSid` | `WW2c597b1d5a96635b6cb0b6d261c9ede8` (filter `type=="support_ticket"`) |
| `supportQueueSid` | `WQ9d76ef58cf2f171d511c36e0e0b05851` (target `routing.skills HAS 'support'`, FIFO Cherry-Pick per Connie standard) |
| `conversationsServiceSid` | `IS8bd6c045af0643e4ab201d44b1aa22ad` (TT-dedicated "TroubleTracker Bridge" service) |
| `taskAttributeType` | `support_ticket` |
| `taskChannel` | `email` |
| `iframeBaseUrl` | `https://trouble-ticket-app.vercel.app/bridge/twilio-flex/ticket` |
| `deploymentId` | `connie` (load-bearing for task-webhook discriminator gate) |

---

## Webhook URL contract (CCTO-side configuration)

These webhook URLs are configured via Twilio REST by CCTO (NOT the CEO via
console). Both fire against `trouble-ticket-app.vercel.app` (per Phase 0a
allowed-origins config).

### Conversations Service-level webhook (already attached, ledger row B2)

```bash
twilio api:conversations:v1:services:configuration:webhooks:update \
  --chat-service-sid IS8bd6c045af0643e4ab201d44b1aa22ad \
  --post-webhook-url "https://trouble-ticket-app.vercel.app/api/bridge/twilio-flex/conversations-webhook" \
  --filter onMessageAdded \
  --method POST
```

### TaskRouter Workspace event-callback URL (DEFERRED — fires post-Phase-3-deploy, ledger row B3)

```bash
twilio api:taskrouter:v1:workspaces:update \
  --sid WSfe43abb4378f0f1e2ebb98877c03bd1d \
  --event-callback-url "https://trouble-ticket-app.vercel.app/api/bridge/twilio-flex/task-webhook" \
  --events-filter "task.completed,task.canceled"
```

**B3 fires AS THE GO-LIVE TRIGGER** for the Twilio→PP inbound chain. See brief
Definition of done step #8 for the full pre-fire CTO verification protocol.

---

## How to add a new deployment

1. Create `deployments/<new-id>/config.json` with a `twilio` block (mirror connie's shape)
2. Add `buildXxxxTwilioConfig()` function in `deployments/<new-id>/index.ts` that hydrates `TwilioBridgeConfig` from the JSON
3. Call `register(xxxxTwilioConfig)` from `app/api/pp-webhook/route.ts` (one call per deployment; idempotent)
4. Have CCTO (or the new deployment's equivalent) attach a service-level Conversations webhook + Workspace event-callback URL to the new deployment's Twilio account
5. Register the deployment's PP tenant webhook to point at `/api/pp-webhook` (per Phase 1 webhook receiver contract)

Each deployment gets its own `TwilioBridgeConfig.deploymentId` value; the
discriminator gate in task-webhook compares against the running deployment's
`deploymentId`. Multi-deployment routing on a single Workspace is fine because
the gate filters by deploymentId.

---

## File map

```
adapters/bridge/human/twilio-flex/
├── README.md             ← this file
├── index.ts              ← public surface (re-exports register, types, BRIDGE_METADATA)
├── types.ts              ← TwilioBridgeConfig, BRIDGE_METADATA constants
├── twilio-client.ts      ← REST wrapper: createTask (TaskRouter), signature verifier, postConversationMessage (Phase 4 reserve)
├── bridge-db.ts          ← twilio_bridge_mappings (taskSid required; interaction/conversation nullable) + twilio_bridge_idempotency
├── handlers.ts           ← onTicketCreated, onTicketRepliedAgent (observe-only)
└── register.ts           ← wires handlers to pp-client.subscribe()

app/api/bridge/twilio-flex/
├── task-webhook/route.ts          ← Twilio TaskRouter event-callback receiver (with discriminator gate — load-bearing)
├── status-flip/route.ts           ← iframe action: pp-client.updateStatus
├── customer-reply/route.ts        ← iframe action: pp-client.addReply (isInternal=false, source='flex')
└── internal-note/route.ts         ← iframe action: pp-client.addReply (isInternal=true, source='flex')

app/bridge/twilio-flex/ticket/[id]/
├── page.tsx              ← server-rendered ticket-context iframe
└── TicketActions.tsx     ← client-side action footer (status flip + customer reply + internal note)

deployments/connie/
├── config.json           ← twilio block + customer scopes + customFieldIds + statusMap
└── index.ts              ← buildConnieConfig() + buildConnieTwilioConfig()
```

---

## Cross-references

- Brief: `vault/projects/trouble-tracker-app/technical/dev-logs/traycer-brief-phase-3.md` (v1.2)
- Configuration ledger: `vault/projects/trouble-tracker-app/technical/dev-logs/phase-3-twilio-config-ledger.md`
- Manifesto v2.2: `vault/projects/trouble-tracker-app/documents/manifesto.md`
- pp-client contract: `pp-client/README.md`
- ONR-77 (TT sprint), ONR-78 (PR Gating adoption), ONR-79 (bot identity)
