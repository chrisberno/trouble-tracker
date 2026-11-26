import type { ChannelsConfig, DeploymentConfig } from '@/pp-client/types';
import type { TwilioBridgeConfig } from '@/adapters/bridge/human/twilio-flex/types';
import config from './config.json';

export function buildConnieConfig(): DeploymentConfig {
  return {
    tenantUrl: config.ppTenant.url,
    tenantApiToken: process.env[config.ppTenant.apiTokenEnvVar] ?? '',
    customerScopeRule: (req: unknown): string => {
      const headers =
        req && typeof req === 'object' && 'headers' in req
          ? (req as { headers?: Record<string, string | undefined> }).headers
          : undefined;
      const referer = headers?.referer ?? headers?.referrer;
      if (!referer || typeof referer !== 'string') return 'Unknown';
      for (const entry of config.customerScopes) {
        if (referer.includes(entry.refererMatch)) return entry.scope;
      }
      return 'Unknown';
    },
    statusMap: config.statusMap,
    customFieldIds: config.customFieldIds,
    channels: (config as { channels?: ChannelsConfig }).channels,
  };
}

export function buildConnieTwilioConfig(): TwilioBridgeConfig {
  return {
    accountSid: process.env[config.twilio.accountSidEnvVar] ?? '',
    authToken: process.env[config.twilio.authTokenEnvVar] ?? '',
    workspaceSid: config.twilio.workspaceSid,
    supportWorkflowSid: config.twilio.supportWorkflowSid,
    supportQueueSid: config.twilio.supportQueueSid,
    conversationsServiceSid: config.twilio.conversationsServiceSid,
    taskAttributeType: config.twilio.taskAttributeType,
    taskChannel: config.twilio.taskChannel,
    iframeBaseUrl: config.twilio.iframeBaseUrl,
    deploymentId: config.id,
    taskTimeoutSeconds: (config.twilio as { taskTimeoutSeconds?: number }).taskTimeoutSeconds,
  };
}

// Last-resort client lookup for a ticket that arrived with no client (2026-11-26).
// The support page can lose track of which client a staff member belongs to (any
// "Home" link inside it drops the client from the address), and the ticket then
// saved as "Unknown" and appeared in no list. A staff email domain listed under a
// client's `emailDomains` in config.json settles it. Returns null when no domain
// matches; the caller keeps "Unknown", which the CareTeam list shows as "No client".
export function customerScopeFromEmail(email: string): string | null {
  const domain = (email.split('@').pop() ?? '').trim().toLowerCase();
  if (!domain) return null;
  for (const entry of config.customerScopes as { scope: string; emailDomains?: string[] }[]) {
    if ((entry.emailDomains ?? []).some((d) => d.toLowerCase() === domain)) return entry.scope;
  }
  return null;
}

export const connieConfig = buildConnieConfig();
export const connieTwilioConfig = buildConnieTwilioConfig();
