// pp-client/internal-db.ts
// pp-client's own DB access — isolated from the legacy lib/db.ts production layer.
// Uses @vercel/postgres directly. lib/db.ts is NOT imported here.

import { sql } from '@vercel/postgres';

export async function initIdempotencyTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS pp_webhook_idempotency (
      event_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

export async function isEventProcessed(eventId: string): Promise<boolean> {
  await initIdempotencyTable();
  // Clean up events older than 24 hours
  await sql`DELETE FROM pp_webhook_idempotency WHERE processed_at < NOW() - INTERVAL '24 hours'`;
  const result = await sql`SELECT 1 FROM pp_webhook_idempotency WHERE event_id = ${eventId}`;
  return (result.rowCount ?? 0) > 0;
}

export async function markEventProcessed(eventId: string): Promise<void> {
  await sql`
    INSERT INTO pp_webhook_idempotency (event_id) VALUES (${eventId})
    ON CONFLICT (event_id) DO NOTHING
  `;
}
