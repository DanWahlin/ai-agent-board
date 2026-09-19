import type { AgentSessionHooks } from '@codewithdan/agent-sdk-core';
import type { OrchestrationMode } from '../types.js';

/**
 * Agent Board is headless, so Hermes ACP permission prompts need an explicit
 * operator-owned policy. Keep the default fail-closed and opt in only through
 * the production service environment.
 */
export function hermesPermissionHooks(
  agentType: string | undefined,
  mode: OrchestrationMode,
  codingConfigured: string | undefined,
  codingSandboxed: string | undefined,
  agentDefaultConfigured: string | undefined,
): AgentSessionHooks | undefined {
  const enabled = (value: string | undefined) => ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
  const approved = mode === 'agent-default'
    ? enabled(agentDefaultConfigured)
    : enabled(codingConfigured) && enabled(codingSandboxed);
  if (agentType !== 'hermes' || !approved) {
    return undefined;
  }
  return {
    onPermissionRequest: () => ({ kind: 'approved' }),
  };
}
