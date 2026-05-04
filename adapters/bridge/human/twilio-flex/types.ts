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
  conversationsServiceSid: string;   // TT-dedicated service per ledger Phase B B1; Phase 4 ACTIVE (atomic-pair pattern uses this for all bridge-created Conversations)
  taskAttributeType: string;         // e.g. 'support_ticket' — distinguishes routing intent
  taskChannel: string;               // e.g. 'email' — capacity-counting channel; Phase 4 task creation uses 'email' specifically (CCTO refinement #1) so basecamp Email.tsx renders native Conversation UI in Task Canvas
  iframeBaseUrl: string;             // e.g. 'https://trouble-ticket-app.vercel.app/bridge/twilio-flex/ticket' — per-ticket iframe (Phase 3); Phase 8a flips eCRM container url template to customer-profile route
  deploymentId: string;              // e.g. 'connie' — load-bearing for task-webhook discriminator gate
}

// Bridge-level metadata declared per Manifesto v2.2 Bridge Contract.
// Consumed by upstream tooling (registries, dashboards) and self-documenting.
export const BRIDGE_METADATA = {
  resolverType: 'human' as const,
  iframeUrlPattern: '/bridge/twilio-flex/ticket/{id}',
  source: 'flex' as const,           // opaque source-tag for loop prevention
} as const;

export type BridgeSource = typeof BRIDGE_METADATA.source;
