// app/api/pp-webhook/route.ts
// Webhook receiver. Validates signature and dispatches to pp-client handlers.
// All upstream-system knowledge lives behind pp-client; this route file only
// reads env-supplied config values and forwards the raw body.
// Production routes (app/api/tickets/) are NOT touched.

import { NextRequest, NextResponse } from 'next/server';
import { handleWebhook } from '@/pp-client/index';
import type { DeploymentConfig } from '@/pp-client/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Webhook receiver config: tenant URL + token come from env vars set by
// the deployment owner. No literal upstream domains live in this file.
const defaultConfig: DeploymentConfig = {
  tenantUrl: process.env.TROUBLETRACKER_TENANT_URL ?? '',
  tenantApiToken: process.env.TROUBLETRACKER_TENANT_API_TOKEN ?? '',
  customerScopeRule: () => 'unknown',
  statusMap: {
    open: 1,
    in_progress: 2,
    waiting: 4,
    // resolved: undefined — deployment owner configures this
    closed: 5,
  },
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = Buffer.from(await request.arrayBuffer());
    const result = await handleWebhook(rawBody, defaultConfig);

    if (result.status === 'error') {
      return NextResponse.json({ error: 'Webhook processing failed' }, { status: 400 });
    }

    return NextResponse.json(
      { ok: true, eventsDispatched: result.events.length },
      { status: 200 },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        pp_webhook_error: true,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// Return 405 for non-POST methods (confirms route is live).
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
