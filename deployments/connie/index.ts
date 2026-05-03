import type { DeploymentConfig } from '@/pp-client/types';
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
  };
}

export const connieConfig = buildConnieConfig();
