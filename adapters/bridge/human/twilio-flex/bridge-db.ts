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
// Mapping table — ticket → Twilio task (+ Conversation)
//
// Phase 4 (2026-05-04): atomicity-hardened pattern per PP-CTO refinement #1.
// Mapping row is inserted with status='pending' BEFORE either Twilio API call.
// Status transitions:
//   pending                  → row written, no Twilio activity yet
//   complete                 → both Conversation AND Task created successfully
//   failed-conversation-create → Conversation create failed (mapping persisted, no SIDs)
//   failed-task-create       → Conversation succeeded, Task failed (compensating delete attempted)
//   failed-no-twilio         → reconcile job found pending row past grace period with no SIDs
//
// Reconcile job (app/api/cron/reconcile-bridge-mappings) sweeps status='pending'
// AND created_at < NOW() - INTERVAL '1 hour' to catch persistence-side failures.
//
// Phase 3 history: schema relaxed interaction_sid + conversation_sid to nullable
// when the v1→v2 pivot dropped Flex Interactions API. Phase 4 keeps them
// nullable; conversation_sid is now actively populated post-Conversation-create.
//
// All schema migrations below are idempotent (CREATE IF NOT EXISTS / ALTER ...
// DROP NOT NULL / ADD COLUMN IF NOT EXISTS).
// ============================================================================

export type BridgeMappingStatus =
  | 'pending'
  | 'complete'
  | 'failed-conversation-create'
  | 'failed-task-create'
  | 'failed-no-twilio';

export interface BridgeMapping {
  ticketId: string;
  interactionSid: string | null;       // Phase 4 forward-compat; null in Phase 3 + 4
  conversationSid: string | null;      // Phase 4 active; null until Conversation create succeeds
  taskSid: string | null;              // Phase 4 active; null until Task create succeeds
  status: BridgeMappingStatus;         // Phase 4 atomicity column
  createdAt: string;
}

export async function initBridgeMappingTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS twilio_bridge_mappings (
      ticket_id TEXT PRIMARY KEY,
      interaction_sid TEXT,
      conversation_sid TEXT,
      task_sid TEXT,
      status TEXT NOT NULL DEFAULT 'complete',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Phase 3 v2 schema migration: drop NOT NULL on interaction_sid + conversation_sid
  // (idempotent — no-op if already nullable).
  await sql`ALTER TABLE twilio_bridge_mappings ALTER COLUMN interaction_sid DROP NOT NULL`;
  await sql`ALTER TABLE twilio_bridge_mappings ALTER COLUMN conversation_sid DROP NOT NULL`;
  // Phase 4 schema migration: drop NOT NULL on task_sid (was Phase 3 required;
  // Phase 4 atomicity inserts row before Task create, so task_sid starts null);
  // add status column if not present.
  await sql`ALTER TABLE twilio_bridge_mappings ALTER COLUMN task_sid DROP NOT NULL`;
  await sql`ALTER TABLE twilio_bridge_mappings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete'`;
  await sql`
    CREATE INDEX IF NOT EXISTS twilio_bridge_mappings_conversation_sid_idx
    ON twilio_bridge_mappings(conversation_sid)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS twilio_bridge_mappings_task_sid_idx
    ON twilio_bridge_mappings(task_sid)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS twilio_bridge_mappings_status_created_at_idx
    ON twilio_bridge_mappings(status, created_at)
  `;
}

/**
 * Phase 4: write mapping row with status='pending' BEFORE any Twilio API call.
 * Closes the post-Twilio-success-pre-DB-write hole per PP-CTO refinement #1.
 * Idempotent: ON CONFLICT does nothing (lets retries proceed without disturbing
 * an existing in-flight row).
 */
export async function insertPendingMapping(ticketId: string): Promise<void> {
  await initBridgeMappingTable();
  await sql`
    INSERT INTO twilio_bridge_mappings (ticket_id, status)
    VALUES (${ticketId}, 'pending')
    ON CONFLICT (ticket_id) DO NOTHING
  `;
}

/**
 * Phase 4: update mapping with a SID + optional status transition. Used as
 * Twilio creations succeed (Conversation, then Task). Final call sets
 * status='complete' once both SIDs are populated.
 */
export async function updateMappingSid(
  ticketId: string,
  sid: { conversationSid?: string; taskSid?: string; status?: BridgeMappingStatus },
): Promise<void> {
  await sql`
    UPDATE twilio_bridge_mappings
    SET
      conversation_sid = COALESCE(${sid.conversationSid ?? null}, conversation_sid),
      task_sid = COALESCE(${sid.taskSid ?? null}, task_sid),
      status = COALESCE(${sid.status ?? null}, status)
    WHERE ticket_id = ${ticketId}
  `;
}

/**
 * Reconcile job query — find pending rows past grace period.
 * Used by /api/cron/reconcile-bridge-mappings.
 */
export async function findStalePendingMappings(graceMinutes: number = 60): Promise<BridgeMapping[]> {
  await initBridgeMappingTable();
  const result = await sql`
    SELECT ticket_id, interaction_sid, conversation_sid, task_sid, status, created_at
    FROM twilio_bridge_mappings
    WHERE status = 'pending' AND created_at < NOW() - INTERVAL '1 hour'
    ORDER BY created_at ASC
    LIMIT 50
  `;
  return result.rows.map((row) => ({
    ticketId: row.ticket_id as string,
    interactionSid: (row.interaction_sid as string | null) ?? null,
    conversationSid: (row.conversation_sid as string | null) ?? null,
    taskSid: (row.task_sid as string | null) ?? null,
    status: row.status as BridgeMappingStatus,
    createdAt: (row.created_at as Date | string).toString(),
  }));
}

/**
 * Phase 3 / Phase 4 inheritance — kept for backward compat with code paths that
 * wrote completed mappings in one shot. Phase 4 prefers insertPendingMapping +
 * updateMappingSid pair instead. Marks status='complete' for legacy callers.
 */
export async function upsertBridgeMapping(
  mapping: Omit<BridgeMapping, 'createdAt' | 'status'> & { status?: BridgeMappingStatus },
): Promise<void> {
  await initBridgeMappingTable();
  const status = mapping.status ?? 'complete';
  await sql`
    INSERT INTO twilio_bridge_mappings (ticket_id, interaction_sid, conversation_sid, task_sid, status)
    VALUES (${mapping.ticketId}, ${mapping.interactionSid}, ${mapping.conversationSid}, ${mapping.taskSid}, ${status})
    ON CONFLICT (ticket_id) DO UPDATE SET
      interaction_sid = COALESCE(EXCLUDED.interaction_sid, twilio_bridge_mappings.interaction_sid),
      conversation_sid = COALESCE(EXCLUDED.conversation_sid, twilio_bridge_mappings.conversation_sid),
      task_sid = COALESCE(EXCLUDED.task_sid, twilio_bridge_mappings.task_sid),
      status = EXCLUDED.status
  `;
}

export async function getBridgeMappingByTicketId(
  ticketId: string,
): Promise<BridgeMapping | null> {
  await initBridgeMappingTable();
  const result = await sql`
    SELECT ticket_id, interaction_sid, conversation_sid, task_sid, status, created_at
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
    taskSid: (row.task_sid as string | null) ?? null,
    status: (row.status as BridgeMappingStatus | undefined) ?? 'complete',
    createdAt: (row.created_at as Date | string).toString(),
  };
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
    SELECT ticket_id, interaction_sid, conversation_sid, task_sid, status, created_at
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
    taskSid: (row.task_sid as string | null) ?? null,
    status: (row.status as BridgeMappingStatus | undefined) ?? 'complete',
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
