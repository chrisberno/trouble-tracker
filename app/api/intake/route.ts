import { NextRequest, NextResponse, after } from 'next/server';
import { handleWebFormIntake } from '@/adapters/inbound/web-form/handler';
import { connieConfig, connieTwilioConfig } from '@/deployments/connie';
import config from '@/deployments/connie/config.json';
import { dispatchTicketCreated } from '@/adapters/bridge/human/twilio-flex';

export const runtime = 'nodejs';
// In-process bridge dispatch (Pattern B: 5 Twilio API creates) runs via
// next/server's after() — outside the request/response cycle but still
// within Vercel's function lifetime. Default Vercel function timeout is 10s;
// allow 30s to accommodate cold-start + full Pattern B chain.
export const maxDuration = 30;

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
    // 2026-05-15: in-process Twilio Flex bridge dispatch via next/server
    // after(). Fire-and-forget by design — form returns 201 in ~500ms while
    // Pattern B (5 Twilio API creates: createConversation, addParticipant,
    // postMessage, addWebhook, createInteraction) runs in the background of
    // the same Vercel function lifetime. Scope is already known from the
    // intake body, so this path is race-free.
    //
    // PP's ticket.created webhook still fires ~5-10s later. The webhook
    // receiver's bridge dispatch re-enters onTicketCreated with the SAME
    // ticketId → SAME idempotency key (`twilio:task:<ticketId>`) →
    // isBridgeKeyProcessed returns true → short-circuit. No duplicate
    // Twilio resources. See dispatch.ts for the doctrine.
    //
    // Error semantics: dispatchTicketCreated swallows + logs. The PP
    // webhook is the eventual-consistency backstop for partial failures.
    if (result.ticketCreatedEvent) {
      after(dispatchTicketCreated(result.ticketCreatedEvent, connieTwilioConfig));
    }

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
