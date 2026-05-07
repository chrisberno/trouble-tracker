// lib/bridge-bootstrap.ts
//
// Module-load side effect: registers the Twilio Flex bridge against pp-client's
// event dispatch for the Connie deployment.
//
// Why this exists (TTB-17 follow-up, 2026-05-07):
//   Vercel runs each Next.js API route in its own isolated Node runtime. The
//   `handlers` Map inside `pp-client/index.ts` is per-runtime — module-scope
//   subscriptions made in one route file do NOT cross-pollinate to other routes.
//
//   Originally only `app/api/pp-webhook/route.ts` called `register(...)` at
//   module load, so the bridge was wired for PP webhook deliveries but NOT for
//   any code path that calls `publish(...)` from elsewhere (e.g. the synthetic
//   intake-driven publish added in TTB-17).
//
//   This bootstrap consolidates the registration. Any route that calls
//   `publish(...)` — directly or transitively via an adapter — must import this
//   module for its side effect:
//
//     import '@/lib/bridge-bootstrap';
//
//   `register()` is idempotent (guarded inside register.ts), so importing this
//   from multiple routes is safe.
//
// If a future deployment beyond Connie joins the bridge, add its register()
// call below.

import { register as registerTwilioBridge } from '@/adapters/bridge/human/twilio-flex';
import { connieTwilioConfig } from '@/deployments/connie';

registerTwilioBridge(connieTwilioConfig);

// Tiny export prevents tree-shaking from eliding the side-effect import in
// some bundler configurations. Importers do NOT need to use this value.
export const bridgeBootstrapped = true;
