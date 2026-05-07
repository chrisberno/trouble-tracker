import { NextRequest, NextResponse } from 'next/server';
import { handleWebFormIntake } from '@/adapters/inbound/web-form/handler';
import { connieConfig, connieTwilioConfig } from '@/deployments/connie';
import config from '@/deployments/connie/config.json';
import { register as registerTwilioBridge } from '@/adapters/bridge/human/twilio-flex';

export const runtime = 'nodejs';

// TTB-17 follow-up (2026-05-07): direct module-scope register call.
//
// Vercel runs each Next.js API route in its own isolated Node runtime — the
// handlers Map inside pp-client/index.ts is per-route. The synthetic
// publish('ticket.created') from handleWebFormIntake fires into THIS route's
// handler map, so the bridge must be subscribed in THIS route's module load.
//
// The first attempt at this fix (PR #19) used a shared `lib/bridge-bootstrap`
// side-effect import — Next.js + swc tree-shook the import despite the value
// export. Direct call here mirrors the pattern in app/api/pp-webhook/route.ts
// and is bundler-stable. register() has its own idempotency guard.
registerTwilioBridge(connieTwilioConfig);

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
