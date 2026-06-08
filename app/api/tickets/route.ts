import { NextRequest, NextResponse } from 'next/server';
import { getTicketsByCustomer } from '@/lib/db';

// CORS configuration - allow localhost for development testing
const allowedOrigins = ['https://connie.plus', 'http://localhost:3000'];

const corsOptions = {
  'Access-Control-Allow-Origin': 'https://connie.plus', // Will be set dynamically below
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Allow-Credentials': 'true'
};

function dynamicCors(request: NextRequest) {
  const origin = request.headers.get('origin');
  return {
    ...corsOptions,
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin || '') ? (origin || 'https://connie.plus') : 'https://connie.plus'
  };
}

export async function OPTIONS(request: NextRequest) {
  return new Response(null, { status: 200, headers: dynamicCors(request) });
}

// GET stays: ticket lookup by name/phone (read-only). Unaffected by the POST retirement below.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get('name');
    const phone = searchParams.get('phone');

    const tickets = await getTicketsByCustomer(name || undefined, phone || undefined);
    return NextResponse.json(tickets, { headers: dynamicCors(request) });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    return NextResponse.json({ error: 'Failed to fetch tickets' }, {
      status: 500,
      headers: dynamicCors(request)
    });
  }
}

// 2026-06-08 — Legacy unscoped ticket creation RETIRED (fail-closed).
//
// This POST handler used to write tickets to a legacy store with NO customer_scope
// and NO bridge-db mapping, and derived the Twilio task `origin` from the HTTP referer
// (which is connie.plus, never the child Flex domain) so it defaulted to "Unknown".
// Result: tickets arrived in the CareTeam queue as Scope=Unknown — the CareTeam
// during-task view couldn't resolve the tenant, the scope-gated reply read 404'd
// (so the submitting agent never saw replies), and "Show All Tickets" returned nothing.
// Confirmed via controlled A/B 2026-06-08 (legacy ticket #98 = no bridge row;
// scoped ticket #119 via /api/intake = correct NSS scope).
//
// The canonical, scoped path is POST /api/intake (validates + persists customerScope
// and writes the bridge-db mapping). connie.plus's create-ticket page and "Create New
// Ticket" button both route there. This endpoint is fail-closed so that NO surface —
// known or not — can ever create an Unknown-scope orphan ticket again.
export async function POST(request: NextRequest) {
  console.warn(JSON.stringify({
    route: 'POST /api/tickets',
    deprecated: true,
    info: 'rejected legacy unscoped ticket creation; callers must use the scoped /api/intake',
    referer: request.headers.get('referer') ?? null,
    origin: request.headers.get('origin') ?? null,
  }));

  return NextResponse.json(
    {
      error: 'This endpoint is retired. Create tickets via the scoped intake (/intake-v2 → POST /api/intake) so they carry customer_scope and a bridge-db mapping.',
      code: 'LEGACY_TICKETS_POST_RETIRED',
    },
    { status: 410, headers: dynamicCors(request) }
  );
}
