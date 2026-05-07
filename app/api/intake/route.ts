import { NextRequest, NextResponse } from 'next/server';
import { handleWebFormIntake } from '@/adapters/inbound/web-form/handler';
import { connieConfig } from '@/deployments/connie';
import config from '@/deployments/connie/config.json';
// TTB-17 follow-up (2026-05-07): side-effect import registers the Twilio Flex
// bridge against pp-client's event dispatch in this route's runtime. Without
// this, the synthetic `publish(ticket.created)` from handleWebFormIntake fires
// into an empty handler map and the bridge never runs — confirmed by CCTO-4
// during post-merge verification of PR #18. See lib/bridge-bootstrap.ts.
import '@/lib/bridge-bootstrap';

export const runtime = 'nodejs';

function getCorsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin');
  if (origin && config.corsAllowlist.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
  }
  return {};
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const corsHeaders = getCorsHeaders(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, errorMessage: 'Invalid request body' },
      { status: 400, headers: corsHeaders },
    );
  }

  const b = (body ?? {}) as {
    title?: unknown;
    description?: unknown;
    customerName?: unknown;
    customerEmail?: unknown;
    customerPhone?: unknown;
    customerScope?: unknown;
  };

  const title = typeof b.title === 'string' ? b.title : '';
  const description = typeof b.description === 'string' ? b.description : '';
  const customerName = typeof b.customerName === 'string' ? b.customerName : '';
  const customerEmail = typeof b.customerEmail === 'string' ? b.customerEmail : '';
  const customerPhone = typeof b.customerPhone === 'string' ? b.customerPhone : '';

  // TTB-1 Task 8 Phase 1B — caller-supplied customerScope (from URL query
  // forwarded by the intake form) takes precedence when it matches one of
  // the configured scopes. Falls back to the referer-based rule otherwise
  // (today's behavior). Validating against the allowlist prevents arbitrary
  // string injection from the client.
  const allowedScopes = new Set(config.customerScopes.map((c) => c.scope));
  const bodyScope = typeof b.customerScope === 'string' && allowedScopes.has(b.customerScope)
    ? b.customerScope
    : null;
  const customerScope = bodyScope ?? connieConfig.customerScopeRule({
    headers: { referer: request.headers.get('referer') ?? undefined },
  });

  const result = await handleWebFormIntake(
    { title, description, customerName, customerEmail, customerPhone, customerScope },
    connieConfig,
  );

  if (result.status === 'success') {
    return NextResponse.json(
      { ok: true, ticketId: result.ticketId },
      { status: 201, headers: corsHeaders },
    );
  }

  if (result.errorMessage && result.errorMessage.includes('Missing required fields')) {
    return NextResponse.json(
      { ok: false, errorMessage: result.errorMessage },
      { status: 400, headers: corsHeaders },
    );
  }

  return NextResponse.json(
    {
      ok: false,
      errorMessage: result.errorMessage,
      fallbackEmail: config.fallbackEmail,
    },
    { status: 503, headers: corsHeaders },
  );
}

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get('origin');
  if (origin && config.corsAllowlist.includes(origin)) {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
