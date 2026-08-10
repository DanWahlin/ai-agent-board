import type { AgentType } from '@/types';

export const AGENT_DISPLAY: Record<AgentType, { emoji: string; label: string }> = {
  copilot: { emoji: '', label: 'Copilot' },
  claude: { emoji: '', label: 'Claude' },
  codex: { emoji: '', label: 'Codex' },
  opencode: { emoji: '', label: 'OpenCode' },
  hermes: { emoji: '', label: 'Hermes' },
  openclaw: { emoji: '', label: 'OpenClaw' },
  grok: { emoji: '', label: 'Grok' },
};

/** Dropdown-friendly array derived from AGENT_DISPLAY */
export const AGENT_OPTIONS: { value: AgentType; label: string; emoji: string }[] = (
  Object.entries(AGENT_DISPLAY) as [AgentType, { emoji: string; label: string }][]
).map(([value, { emoji, label }]) => ({ value, label, emoji }));

/** Safe lookup — returns undefined for unknown agent types */
export function getAgentDisplay(agentType: string): { emoji: string; label: string } | undefined {
  return AGENT_DISPLAY[agentType as AgentType];
}
