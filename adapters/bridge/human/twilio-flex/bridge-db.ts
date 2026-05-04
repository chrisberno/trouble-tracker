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
// Mapping table — ticket ↔ twilio interaction/conversation
// ============================================================================

export interface BridgeMapping {
  ticketId: string;
  interactionSid: string;
  conversationSid: string;
  taskSid: string | null;
  createdAt: string;
}

export async function initBridgeMappingTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS twilio_bridge_mappings (
      ticket_id TEXT PRIMARY KEY,
      interaction_sid TEXT NOT NULL,
      conversation_sid TEXT NOT NULL,
      task_sid TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS twilio_bridge_mappings_conversation_sid_idx
    ON twilio_bridge_mappings(conversation_sid)
  `;
}

export async function upsertBridgeMapping(
  mapping: Omit<BridgeMapping, 'createdAt'>,
): Promise<void> {
  await initBridgeMappingTable();
  await sql`
    INSERT INTO twilio_bridge_mappings (ticket_id, interaction_sid, conversation_sid, task_sid)
    VALUES (${mapping.ticketId}, ${mapping.interactionSid}, ${mapping.conversationSid}, ${mapping.taskSid})
    ON CONFLICT (ticket_id) DO UPDATE SET
      interaction_sid = EXCLUDED.interaction_sid,
      conversation_sid = EXCLUDED.conversation_sid,
      task_sid = COALESCE(EXCLUDED.task_sid, twilio_bridge_mappings.task_sid)
  `;
}

export async function getBridgeMappingByTicketId(
  ticketId: string,
): Promise<BridgeMapping | null> {
  await initBridgeMappingTable();
  const result = await sql`
    SELECT ticket_id, interaction_sid, conversation_sid, task_sid, created_at
    FROM twilio_bridge_mappings
    WHERE ticket_id = ${ticketId}
    LIMIT 1
  `;
  const row = result.rows[0];
  if (!row) return null;
  return {
    ticketId: row.ticket_id as string,
    interactionSid: row.interaction_sid as string,
    conversationSid: row.conversation_sid as string,
    taskSid: (row.task_sid as string | null) ?? null,
    createdAt: (row.created_at as Date | string).toString(),
  };
}

export async function getBridgeMappingByConversationSid(
  conversationSid: string,
): Promise<BridgeMapping | null> {
  await initBridgeMappingTable();
  const result = await sql`
    SELECT ticket_id, interaction_sid, conversation_sid, task_sid, created_at
    FROM twilio_bridge_mappings
    WHERE conversation_sid = ${conversationSid}
    LIMIT 1
  `;
  const row = result.rows[0];
  if (!row) return null;
  return {
    ticketId: row.ticket_id as string,
    interactionSid: row.interaction_sid as string,
    conversationSid: row.conversation_sid as string,
    taskSid: (row.task_sid as string | null) ?? null,
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
