// adapters/bridge/human/twilio-flex/cors.ts
// CORS helper for bridge routes invoked cross-origin from the basecamp Connie
// Flex plugin running at https://careteam.connie.team. Whitelists exact
// origins (not '*') because future iterations may carry credentials.
//
// Usage: in a Next.js route handler module, export both a `POST` and an
// `OPTIONS` handler. POST wraps its NextResponse with `withCors(req, res)`.
// OPTIONS returns `corsPreflight(req)`.
//
// Routes consuming this surface (TTB-1 Task 7, 2026-05-05):
//   - /api/bridge/twilio-flex/internal-note
//   - /api/bridge/twilio-flex/status-flip
//
// Other bridge routes (task-webhook, conversation-message) are server-to-server
// from Twilio and don't need CORS.

import { NextRequest, NextResponse } from 'next/server';

const ALLOWED_ORIGINS = new Set<string>([
  'https://careteam.connie.team',
  'https://flex.twilio.com',
]);

const ALLOWED_METHODS = 'POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, X-Requested-With';

function originAllowed(origin: string | null): origin is string {
  return !!origin && ALLOWED_ORIGINS.has(origin);
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '600',
  };
  if (originAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function corsPreflight(req: NextRequest): NextResponse {
  const origin = req.headers.get('origin');
  if (!originAllowed(origin)) {
    // Origin not in allowlist — return 204 without CORS headers so the
    // browser blocks the preflight cleanly.
    return new NextResponse(null, { status: 204 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export function withCors(req: NextRequest, res: NextResponse): NextResponse {
  const origin = req.headers.get('origin');
  const headers = corsHeaders(origin);
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}
