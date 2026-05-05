// app/api/bridge/twilio-flex/status-flip/route.ts
// Agent flips ticket status (open / in_progress / closed). Calls
// pp-client.updateStatus.
//
// Two clients call this route:
//   1. Legacy iframe page (same-origin) — Pattern A, parallel runtime.
//   2. basecamp Connie Flex plugin (cross-origin from
//      https://careteam.connie.team) — Pattern B (Task 7 / TTB-1).
//
// Auth model (MVP): same-origin trust for the iframe + origin-allowlist trust
// for the plugin. The Flex plugin only loads for authenticated CCT agents
// (Auth0 SSO in front of careteam.connie.team), so requests originating from
// that allowed origin are by definition from authenticated agents.
// Future hardening: pass + verify Flex worker SID against TaskRouter.

import { NextRequest, NextResponse } from 'next/server';
import { updateStatus } from '@/pp-client';
import type { TicketStatus } from '@/pp-client';
import { connieConfig } from '@/deployments/connie';
import { corsPreflight, withCors } from '@/adapters/bridge/human/twilio-flex/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES: TicketStatus[] = ['open', 'in_progress', 'closed'];

interface StatusFlipBody {
  ticketId?: unknown;
  status?: unknown;
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  return corsPreflight(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as StatusFlipBody;

    const ticketId = typeof body.ticketId === 'string' ? body.ticketId : '';
    const status = typeof body.status === 'string' ? body.status : '';

    if (!ticketId) {
      return withCors(request, NextResponse.json({ error: 'ticketId required' }, { status: 400 }));
    }
    if (!ALLOWED_STATUSES.includes(status as TicketStatus)) {
      return withCors(
        request,
        NextResponse.json(
          { error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` },
          { status: 400 },
        ),
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

    return withCors(request, NextResponse.json({ ok: true, ticketId, status: updated.status }, { status: 200 }));
  } catch (err) {
    console.error(JSON.stringify({
      bridge: 'twilio-flex',
      route: 'status-flip',
      error: err instanceof Error ? err.message : String(err),
    }));
    return withCors(
      request,
      NextResponse.json(
        { error: err instanceof Error ? err.message : 'Status flip failed' },
        { status: 500 },
      ),
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
