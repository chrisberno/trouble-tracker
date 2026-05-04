# adapters/bridge/human/twilio-flex

Twilio Flex bridge adapter — the first concrete bridge in the Onreb portfolio.
Lives at `adapters/bridge/human/twilio-flex/` per Manifesto v2.2 layout
(`human/` segment maps to `resolverType: "human"` per the Bridge Contract).

**Phase 3 of TroubleTracker Sprint 1.0** (ONR-77). Brief at
`vault/projects/trouble-tracker-app/technical/dev-logs/traycer-brief-phase-3.md`.

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

## Flows (4 inbound, 2 outbound — relative to PP.app)

### Outbound (PP → Twilio)

```
PP ticket.created webhook
  → pp-client emits CoreEvent { kind: 'ticket.created' }
  → handlers.onTicketCreated
  → twilio-client.createInteraction(workspace + workflow + queue + attributes)
  → Twilio creates: Interaction + Conversation + Task in CCT WorkBench
  → bridge-db.upsertBridgeMapping(ticketId → interactionSid + conversationSid + taskSid)
```

```
PP ticket.replied.customer webhook (customer-side reply on the ticket)
  → pp-client emits CoreEvent { kind: 'ticket.replied.customer' }
  → handlers.onTicketRepliedCustomer
  → bridge-db.getBridgeMappingByTicketId → conversationSid
  → twilio-client.postConversationMessage(convoSid, body, author='customer')
  → Agent sees the customer's message inline in their Flex Conversation
```

### Inbound (Twilio → PP)

```
Agent message in Flex WorkBench
  → Twilio Conversations Service-level onMessageAdded webhook fires
  → /api/bridge/twilio-flex/conversations-webhook
  → verifyTwilioSignature (X-Twilio-Signature HMAC-SHA1)
  → skip if Author=customer (own outbound) or duplicate idempotency key
  → bridge-db.getBridgeMappingByConversationSid → ticketId
  → pp-client.addReply(ticketId, { body, source: 'flex' })
  → PP fires ticket.replied.agent webhook → handlers.onTicketRepliedAgent observes (no Twilio re-write)
```

```
Agent completes Task in WorkBench
  → Twilio TaskRouter Workspace event-callback fires (post-B3-go-live)
  → /api/bridge/twilio-flex/task-webhook
  → verifyTwilioSignature
  → DISCRIMINATOR GATE (load-bearing): short-circuit if attributes.deploymentId !== 'connie'
  → on EventType=task.completed: pp-client.closeTicket(ticketId)
  → PP fires ticket.status_changed webhook (Phase 3 takes no further action)
```

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

## Twilio API surface used

- **Interactions API** (`flex.twilio.com/v1/Interactions`) — POST creates Task + Conversation atomically
- **Conversations API** (`conversations.twilio.com/v1/Services/<IS...>/Conversations/<CH...>/Messages`) — POST agent/customer messages
- **TaskRouter Workspace event-callback** (configured via `taskrouter.twilio.com/v1/Workspaces/<WS...>` PUT) — fires on `task.completed` / `task.canceled`
- **Conversations Service-level webhook** (configured via `conversations.twilio.com/v1/Services/<IS...>/Configuration/Webhooks` POST) — fires on `onMessageAdded`

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
├── twilio-client.ts      ← REST wrapper for Interactions + Conversations APIs; signature verifier
├── bridge-db.ts          ← twilio_bridge_mappings + twilio_bridge_idempotency tables (Postgres)
├── handlers.ts           ← onTicketCreated, onTicketRepliedCustomer, onTicketRepliedAgent
└── register.ts           ← wires handlers to pp-client.subscribe()

app/api/bridge/twilio-flex/
├── conversations-webhook/route.ts   ← Twilio Conversations onMessageAdded receiver
├── task-webhook/route.ts            ← Twilio TaskRouter event-callback receiver (with discriminator gate)
├── status-flip/route.ts             ← iframe action: pp-client.updateStatus
└── internal-note/route.ts           ← iframe action: pp-client.addReply (isInternal, source='flex')

app/bridge/twilio-flex/ticket/[id]/
├── page.tsx              ← server-rendered ticket-context iframe
└── TicketActions.tsx     ← client-side action footer (status flip + internal note)

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
