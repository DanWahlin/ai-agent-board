import type { AgentSessionHooks } from '@codewithdan/agent-sdk-core';

/**
 * Agent Board is headless, so Hermes ACP permission prompts need an explicit
 * operator-owned policy. Keep the default fail-closed and opt in only through
 * the production service environment.
 */
export function hermesPermissionHooks(
  agentType: string | undefined,
  configured: string | undefined,
): AgentSessionHooks | undefined {
  if (agentType !== 'hermes' || !['1', 'true', 'yes', 'on'].includes((configured ?? '').trim().toLowerCase())) {
    return undefined;
  }
  return {
    onPermissionRequest: () => ({ kind: 'approved' }),
  };
}
