import type { AgentSessionHooks } from '@codewithdan/agent-sdk-core';

/**
 * Agent Board is headless, so Hermes ACP permission prompts need an explicit
 * operator-owned policy. Keep the default fail-closed and opt in only through
 * the production service environment.
 */
export function hermesPermissionHooks(
  agentType: string | undefined,
  configured: string | undefined,
  sandboxed: string | undefined,
): AgentSessionHooks | undefined {
  const enabled = (value: string | undefined) => ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
  if (agentType !== 'hermes' || !enabled(configured) || !enabled(sandboxed)) {
    return undefined;
  }
  return {
    onPermissionRequest: () => ({ kind: 'approved' }),
  };
}
