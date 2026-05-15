// adapters/bridge/human/twilio-flex/bridge-db.ts
// Bridge-internal Postgres access. Stores PP-ticket → Twilio-{Interaction,Conversation}
// mappings and bridge-side idempotency keys for inbound Twilio webhooks.
//
// Per brief escalation rule: do NOT extend pp-client/internal-db.ts. The bridge
// owns its own table to keep substrate boundaries clean.
//
// Uses @vercel/postgres directly (same connection pool pp-client uses).

import { sql } from '@vercel/postgres';

// ============================================================================
// Mapping table — ticket → Twilio task (+ optional interaction/conversation)
//
// Phase 3 v2 (after TaskRouter Tasks API pivot): only `taskSid` is required.
// `interactionSid` and `conversationSid` are nullable — Phase 3 does not create
// either (no Flex Interactions API call, no per-task Conversation). They stay
// in the schema for Phase 4 forward-compat (when we wire the customer email
// loop and may create Conversations again).
//
// CREATE TABLE IF NOT EXISTS is idempotent. The original schema had
// `interaction_sid TEXT NOT NULL`; we use ALTER TABLE in initBridgeMappingTable
// to relax that constraint at runtime so Phase 3 deploys cleanly even if the
// table was created by an earlier (now-deleted) Phase 3 v1 attempt. New
// installs (no prior table) will get the relaxed schema directly via the
// CREATE TABLE statement.
// ============================================================================

export interface BridgeMapping {
  ticketId: string;
  interactionSid: string | null;       // Phase 4 forward-compat; null in Phase 3
  conversationSid: string | null;      // Phase 4 forward-compat; null in Phase 3
  taskSid: string;                     // Phase 3 required
  customerScope: string | null;        // TTB-17: bridge-db is the source of truth for ticketId→scope; PP REST API does not return custom_fields in GET /api/tickets/<id> at any shape (verified 2026-05-06).
  createdAt: string;
}

export async function initBridgeMappingTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS twilio_bridge_mappings (
      ticket_id TEXT PRIMARY KEY,
      interaction_sid TEXT,
      conversation_sid TEXT,
      task_sid TEXT NOT NULL,
      customer_scope TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Phase 3 v2 schema migration: if a prior install created the table with
  // NOT NULL constraints on interaction_sid/conversation_sid, drop those.
  // ALTER TABLE ... DROP NOT NULL is idempotent in Postgres (no error if the
  // column is already nullable).
  await sql`ALTER TABLE twilio_bridge_mappings ALTER COLUMN interaction_sid DROP NOT NULL`;
  await sql`ALTER TABLE twilio_bridge_mappings ALTER COLUMN conversation_sid DROP NOT NULL`;
  // TTB-17 schema migration: add customer_scope column on prior installs that
  // pre-date the column. ADD COLUMN IF NOT EXISTS is idempotent; existing rows
  // get NULL until a subsequent ticket-update writes the value.
  await sql`ALTER TABLE twilio_bridge_mappings ADD COLUMN IF NOT EXISTS customer_scope TEXT`;
  await sql`
    CREATE INDEX IF NOT EXISTS twilio_bridge_mappings_conversation_sid_idx
    ON twilio_bridge_mappings(conversation_sid)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS twilio_bridge_mappings_task_sid_idx
    ON twilio_bridge_mappings(task_sid)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS twilio_bridge_mappings_customer_scope_idx
    ON twilio_bridge_mappings(customer_scope)
  `;
}

export async function upsertBridgeMapping(
  mapping: Omit<BridgeMapping, 'createdAt'>,
): Promise<void> {
  await initBridgeMappingTable();
  await sql`
    INSERT INTO twilio_bridge_mappings (ticket_id, interaction_sid, conversation_sid, task_sid, customer_scope)
    VALUES (${mapping.ticketId}, ${mapping.interactionSid}, ${mapping.conversationSid}, ${mapping.taskSid}, ${mapping.customerScope})
    ON CONFLICT (ticket_id) DO UPDATE SET
      interaction_sid = COALESCE(EXCLUDED.interaction_sid, twilio_bridge_mappings.interaction_sid),
      conversation_sid = COALESCE(EXCLUDED.conversation_sid, twilio_bridge_mappings.conversation_sid),
      task_sid = EXCLUDED.task_sid,
      customer_scope = COALESCE(EXCLUDED.customer_scope, twilio_bridge_mappings.customer_scope)
  `;
}

export async function getBridgeMappingByTicketId(
  ticketId: string,
): Promise<BridgeMapping | null> {
  await initBridgeMappingTable();
  const result = await sql`
    SELECT ticket_id, interaction_sid, conversation_sid, task_sid, customer_scope, created_at
    FROM twilio_bridge_mappings
    WHERE ticket_id = ${ticketId}
    LIMIT 1
  `;
  const row = result.rows[0];
  if (!row) return null;
  return {
    ticketId: row.ticket_id as string,
    interactionSid: (row.interaction_sid as string | null) ?? null,
    conversationSid: (row.conversation_sid as string | null) ?? null,
    taskSid: row.task_sid as string,
    customerScope: (row.customer_scope as string | null) ?? null,
    createdAt: (row.created_at as Date | string).toString(),
  };
}

// TTB-17: list ticketIds bound to a scope. Source of truth for the
// /bridge/tickets account-context view — PP REST does not return custom_fields,
// so we cannot reliably ask PP "which tickets are NSS." Bridge-db owns this
// index.
export async function listTicketIdsByScope(
  scope: string,
  limit = 100,
): Promise<string[]> {
  await initBridgeMappingTable();
  const result = await sql`
    SELECT ticket_id
    FROM twilio_bridge_mappings
    WHERE customer_scope = ${scope}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return result.rows.map((r) => r.ticket_id as string);
}

// TTB-17 fix #3: pre-write the customer_scope binding from the intake handler
// BEFORE PP fires its ticket.created webhook. This makes bridge-db the
// authoritative source for ticketId→scope, decoupling the bridge from any
// runtime/bundler/race quirks of in-process pub/sub. The bridge handler
// (onTicketCreated) reads this row at the top and uses its scope as the
// effective value, regardless of what the event payload says.
//
// Inserts a placeholder mapping with task_sid empty; the real upsert from
// onTicketCreated populates task_sid + sids and (via COALESCE) preserves the
// pre-written customer_scope. Idempotent — if the row already exists with a
// scope value, we don't overwrite it (early call wins; subsequent calls with
// a more-specific scope can be added later if needed).
export async function prewriteBridgeMappingScope(
  ticketId: string,
  scope: string,
): Promise<void> {
  if (!scope) return;
  await initBridgeMappingTable();
  await sql`
    INSERT INTO twilio_bridge_mappings (ticket_id, task_sid, customer_scope)
    VALUES (${ticketId}, '', ${scope})
    ON CONFLICT (ticket_id) DO UPDATE SET
      customer_scope = COALESCE(twilio_bridge_mappings.customer_scope, EXCLUDED.customer_scope)
  `;
}

/**
 * Phase 4 forward-compat — not used in Phase 3 (the conversations-webhook
 * route was removed; no customer-side messages flow into a Twilio Conversation
 * for Phase 3). Kept defined so Phase 4 can re-enable without API churn.
 */
export async function getBridgeMappingByConversationSid(
  conversationSid: string,
): Promise<BridgeMapping | null> {
  await initBridgeMappingTable();
  const result = await sql`
    SELECT ticket_id, interaction_sid, conversation_sid, task_sid, customer_scope, created_at
    FROM twilio_bridge_mappings
    WHERE conversation_sid = ${conversationSid}
    LIMIT 1
  `;
  const row = result.rows[0];
  if (!row) return null;
  return {
    ticketId: row.ticket_id as string,
    interactionSid: (row.interaction_sid as string | null) ?? null,
    conversationSid: (row.conversation_sid as string | null) ?? null,
    taskSid: row.task_sid as string,
    customerScope: (row.customer_scope as string | null) ?? null,
    createdAt: (row.created_at as Date | string).toString(),
  };
}

// ============================================================================
// Bridge idempotency — for inbound Twilio webhooks (and outbound Twilio writes)
//
// Keyed by namespaced strings:
//   twilio:interaction:<ticketId>      — outbound: skip duplicate Interaction creates
//   twilio:message:<replyId>           — outbound: skip duplicate Conversation messages
//   pp:reply:<twilioMessageSid>        — inbound:  skip duplicate pp.addReply
//   pp:close:<taskSid>                 — inbound:  skip duplicate pp.closeTicket
// ============================================================================

export async function initBridgeIdempotencyTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS twilio_bridge_idempotency (
      key TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

export async function isBridgeKeyProcessed(key: string): Promise<boolean> {
  await initBridgeIdempotencyTable();
  // GC keys older than 24h on read.
  await sql`DELETE FROM twilio_bridge_idempotency WHERE processed_at < NOW() - INTERVAL '24 hours'`;
  const result = await sql`SELECT 1 FROM twilio_bridge_idempotency WHERE key = ${key}`;
  return (result.rowCount ?? 0) > 0;
}

export async function markBridgeKeyProcessed(key: string): Promise<void> {
  await sql`
    INSERT INTO twilio_bridge_idempotency (key) VALUES (${key})
    ON CONFLICT (key) DO NOTHING
  `;
}

// Atomic "claim if not processed" — returns true on first claim, false if
// another runtime already claimed it. Use INSTEAD of the isBridgeKeyProcessed
// + markBridgeKeyProcessed pair when two runtimes can race the same key.
//
// Why this exists (2026-05-15): the post-#93 race-fix PR added in-process
// bridge dispatch from /api/intake; PP's ticket.created webhook still fires
// as a backstop ~5-10s later. The original check+mark pair (read, then write
// at end of Pattern B) had a 700-1500ms race window where both runtimes
// could pass the check before either wrote the mark. Twilio's REST APIs are
// called WITHOUT the I-Twilio-Idempotency-Token header (twilioFetch logs the
// key locally but does not send it to Twilio — verified twilio-client.ts:50),
// so the local dedup was the SOLE protection against duplicate Twilio
// resources. Atomic claim closes the window.
//
// Postgres ON CONFLICT DO NOTHING + RETURNING is the canonical atomic
// claim pattern. The row is inserted in a single statement; rowCount=1
// means we won, rowCount=0 means another runtime got there first.
export async function tryClaimBridgeKey(key: string): Promise<boolean> {
  await initBridgeIdempotencyTable();
  // GC keys older than 24h on claim.
  await sql`DELETE FROM twilio_bridge_idempotency WHERE processed_at < NOW() - INTERVAL '24 hours'`;
  const result = await sql`
    INSERT INTO twilio_bridge_idempotency (key) VALUES (${key})
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `;
  return (result.rowCount ?? 0) > 0;
}
