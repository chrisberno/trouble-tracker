// app/api/pp-webhook/route.ts
// Webhook receiver. Validates signature and dispatches to pp-client handlers.
// All upstream-system knowledge lives behind pp-client; this route file only
// reads env-supplied config values and forwards the raw body.
// Production routes (app/api/tickets/) are NOT touched.

import { NextRequest, NextResponse } from 'next/server';
import { handleWebhook } from '@/pp-client/index';
import type { DeploymentConfig } from '@/pp-client/types';
import { register as registerTwilioBridge } from '@/adapters/bridge/human/twilio-flex';
import { connieTwilioConfig } from '@/deployments/connie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// TTB-17 fix #6: bridge handler's race-loss backfill path (final bridge-db
// read + 2 Twilio attribute updates) plus the original Pattern B chain
// (5 Twilio API creates) plus cold-start can push past Vercel's default 10s
// function timeout. Explicit 30s ceiling gives backfill room to run; well
// under any plan's hard cap.
export const maxDuration = 30;

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
  // Webhook receiver doesn't write tickets — values are placeholders.
  // Real ticket-write paths use deployment-specific configs (see deployments/connie/).
  customFieldIds: { ticket: { customer_scope: 0, intake_source: 0 } },
};

// TTB-17 follow-up (2026-05-07): direct module-scope register call lives in
// each route that participates in bridge dispatch. Vercel runs each Next.js
// API route in its own isolated Node runtime, so the handlers Map in
// pp-client/index.ts is per-route — register() must run at module load in
// every route that dispatches OR publishes events. Side-effect imports via a
// shared bootstrap module were tried and tree-shaken by the bundler — direct
// call is the safest pattern. register() itself has an idempotency guard.
registerTwilioBridge(connieTwilioConfig);

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
