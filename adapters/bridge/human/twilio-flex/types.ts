// adapters/bridge/human/twilio-flex/types.ts
// Bridge-internal types. Bridge config is bridge-specific so it lives here,
// not on DeploymentConfig (which is pp-client's contract). Deployments build
// both DeploymentConfig (for pp-client) and TwilioBridgeConfig (for this bridge)
// from their config.json.

export interface TwilioBridgeConfig {
  accountSid: string;
  authToken: string;                 // hydrated from env at boot
  workspaceSid: string;
  supportWorkflowSid: string;
  supportQueueSid: string;
  conversationsServiceSid: string;   // TT-dedicated service per ledger Phase B B1
  taskAttributeType: string;         // e.g. 'support_ticket' — distinguishes routing intent
  taskChannel: string;               // e.g. 'email' — capacity-counting channel
  iframeBaseUrl: string;             // e.g. 'https://trouble-ticket-app.vercel.app/bridge/twilio-flex/ticket'
  deploymentId: string;              // e.g. 'connie' — load-bearing for task-webhook discriminator gate
}

// Bridge-level metadata declared per Manifesto v2.2 Bridge Contract.
// Consumed by upstream tooling (registries, dashboards) and self-documenting.
//
// TTB-24 (Sprint 2.0 reopen, 2026-05-08): added `sourceInternal` for the
// internal-note path. PP webhook payload doesn't include the isinternal flag
// in `data.reply` (verified: `admin: null` for both internal + public; no
// `isinternal` key in keys list). The `source` field IS echoed back, so we
// encode the internal vs public distinction into the source value itself.
// `source: 'flex-internal'` for internal notes; `source: 'flex'` for
// customer-visible replies. event-mapper.ts uses substring match on
// 'internal' to set Reply.internalNote.
export const BRIDGE_METADATA = {
  resolverType: 'human' as const,
  iframeUrlPattern: '/bridge/twilio-flex/ticket/{id}',
  source: 'flex' as const,                    // canvas-driven public reply
  sourceInternal: 'flex-internal' as const,   // canvas-driven internal note
} as const;

export type BridgeSource = typeof BRIDGE_METADATA.source | typeof BRIDGE_METADATA.sourceInternal;
