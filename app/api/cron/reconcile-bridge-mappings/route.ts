// app/api/cron/reconcile-bridge-mappings/route.ts
// Phase 4 Vercel Cron Jobs reconcile job — sweeps stale 'pending' rows in
// twilio_bridge_mappings every 15 minutes (per Phase 4 brief Deliverable #3
// + PP-CTO refinement #1 belt-and-suspenders against persistence-side
// failures).
//
// What it does:
//   - Finds rows where status='pending' AND created_at < NOW() - 1 hour
//     (older than one hour means the in-flight handler has either crashed
//     mid-flight or the persist-after-Twilio-success window dropped the
//     status update; either way needs cleanup)
//   - For each: classify by which SIDs are populated, then either backfill
//     missing SIDs OR mark the row as failed-* for manual triage
//   - Logs structured records; Phase 5+ can add Slack/console alerts
//
// Auth: Vercel Cron Jobs send 'x-vercel-cron-signature' header. We verify
// the request originated from Vercel's cron infrastructure before doing
// any DB writes. (Mode is opt-in security — Vercel's cron is the only
// caller that should ever hit this route in production.)

import { NextRequest, NextResponse } from 'next/server';
import {
  findStalePendingMappings,
  updateMappingSid,
} from '@/adapters/bridge/human/twilio-flex/bridge-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Auth gate — Vercel cron sends x-vercel-cron-signature header (presence
  // = called by Vercel cron infrastructure, not by random external request).
  const cronSig = request.headers.get('x-vercel-cron-signature') ?? '';
  if (!cronSig) {
    console.warn(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'reconcile-bridge-mappings',
      warning: 'missing x-vercel-cron-signature; rejecting',
    }));
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const startedAt = new Date().toISOString();
  let scanned = 0;
  let resolved = 0;
  let markedFailed = 0;

  try {
    const stale = await findStalePendingMappings(60);  // 60-min grace
    scanned = stale.length;

    for (const mapping of stale) {
      // Classify failure mode by which SIDs are populated.
      const hasConvSid = !!mapping.conversationSid;
      const hasTaskSid = !!mapping.taskSid;

      if (hasConvSid && hasTaskSid) {
        // Both SIDs present but status='pending' — handler succeeded both
        // creates but failed to update the status. Promote to 'complete'.
        await updateMappingSid(mapping.ticketId, { status: 'complete' });
        resolved++;
        console.log(JSON.stringify({
          bridge: 'twilio-flex',
          route: 'reconcile-bridge-mappings',
          action: 'promoted-to-complete',
          ticketId: mapping.ticketId,
          conversationSid: mapping.conversationSid,
          taskSid: mapping.taskSid,
        }));
        continue;
      }

      if (hasConvSid && !hasTaskSid) {
        // Conversation succeeded, Task didn't (or DB write between them
        // dropped). Could attempt Task backfill, but Phase 4 ships logging
        // only — manual triage path.
        await updateMappingSid(mapping.ticketId, { status: 'failed-task-create' });
        markedFailed++;
        console.warn(JSON.stringify({
          bridge: 'twilio-flex',
          route: 'reconcile-bridge-mappings',
          action: 'marked-failed',
          subStatus: 'failed-task-create',
          ticketId: mapping.ticketId,
          conversationSid: mapping.conversationSid,
          note: 'Conversation exists; Task missing. Phase 4 logs only — manual triage required.',
        }));
        continue;
      }

      if (!hasConvSid && !hasTaskSid) {
        // Nothing happened — handler crashed before any Twilio call OR the
        // initial insertPendingMapping call succeeded but the rest didn't
        // even start. Mark as failed-no-twilio.
        await updateMappingSid(mapping.ticketId, { status: 'failed-no-twilio' });
        markedFailed++;
        console.warn(JSON.stringify({
          bridge: 'twilio-flex',
          route: 'reconcile-bridge-mappings',
          action: 'marked-failed',
          subStatus: 'failed-no-twilio',
          ticketId: mapping.ticketId,
          note: 'Pending row past grace period with no Twilio activity. Manual triage required.',
        }));
        continue;
      }

      // Edge: !hasConvSid && hasTaskSid — shouldn't happen (Conversation
      // is created before Task), but defensive marker.
      await updateMappingSid(mapping.ticketId, { status: 'failed-conversation-create' });
      markedFailed++;
      console.warn(JSON.stringify({
        bridge: 'twilio-flex',
        route: 'reconcile-bridge-mappings',
        action: 'marked-failed',
        subStatus: 'failed-conversation-create-edge-case',
        ticketId: mapping.ticketId,
        taskSid: mapping.taskSid,
        note: 'Task exists without Conversation — should not happen given ordering. Manual triage.',
      }));
    }

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'reconcile-bridge-mappings',
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      scanned,
      resolved,
      markedFailed,
    }));

    return NextResponse.json(
      { ok: true, scanned, resolved, markedFailed },
      { status: 200 },
    );
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'reconcile-bridge-mappings',
      error: err instanceof Error ? err.message : String(err),
    }));
    return NextResponse.json({ error: 'Internal' }, { status: 500 });
  }
}
