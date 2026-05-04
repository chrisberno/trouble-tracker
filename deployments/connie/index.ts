import type { DeploymentConfig } from '@/pp-client/types';
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
  };
}

export const connieConfig = buildConnieConfig();
export const connieTwilioConfig = buildConnieTwilioConfig();
