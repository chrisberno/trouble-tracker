// app/api/bridge/twilio-flex/status-flip/route.ts
// Iframe action endpoint: agent flips ticket status (open / in_progress / closed).
// POSTed by the iframe page client-side; server-side calls pp-client.updateStatus.
//
// Auth model (Phase 3): same-origin trust. The iframe is rendered same-domain
// from this Vercel project; CSP frame-ancestors restricts who can embed it.
// Phase 4+ may add CCT worker SID validation.

import { NextRequest, NextResponse } from 'next/server';
import { updateStatus } from '@/pp-client';
import type { TicketStatus } from '@/pp-client';
import { connieConfig } from '@/deployments/connie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES: TicketStatus[] = ['open', 'in_progress', 'closed'];

interface StatusFlipBody {
  ticketId?: unknown;
  status?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as StatusFlipBody;

    const ticketId = typeof body.ticketId === 'string' ? body.ticketId : '';
    const status = typeof body.status === 'string' ? body.status : '';

    if (!ticketId) {
      return NextResponse.json({ error: 'ticketId required' }, { status: 400 });
    }
    if (!ALLOWED_STATUSES.includes(status as TicketStatus)) {
      return NextResponse.json(
        { error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` },
        { status: 400 },
      );
    }

    const updated = await updateStatus(ticketId, status as TicketStatus, connieConfig);

    console.log(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'status-flip',
      ok: true,
      ticketId,
      newStatus: updated.status,
    }));

    return NextResponse.json({ ok: true, ticketId, status: updated.status }, { status: 200 });
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'status-flip',
      error: err instanceof Error ? err.message : String(err),
    }));
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Status flip failed' },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
