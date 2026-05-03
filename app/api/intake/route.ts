import { NextRequest, NextResponse } from 'next/server';
import { handleWebFormIntake } from '@/adapters/inbound/web-form/handler';
import { connieConfig } from '@/deployments/connie';
import config from '@/deployments/connie/config.json';

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
    customerPhone?: unknown;
  };

  const title = typeof b.title === 'string' ? b.title : '';
  const description = typeof b.description === 'string' ? b.description : '';
  const customerName = typeof b.customerName === 'string' ? b.customerName : '';
  const customerPhone = typeof b.customerPhone === 'string' ? b.customerPhone : '';

  const customerScope = connieConfig.customerScopeRule({
    headers: { referer: request.headers.get('referer') ?? undefined },
  });

  const result = await handleWebFormIntake(
    { title, description, customerName, customerPhone, customerScope },
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
