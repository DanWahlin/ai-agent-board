import type { AgentType, AgentStatus } from '@/types';
import { AGENT_DISPLAY } from '@/lib/agent-config';
import { cn } from '@/lib/utils';

export type StatusFilter = 'running' | 'failed' | 'complete';

const STATUS_CHIPS: { value: StatusFilter; label: string; color: string }[] = [
  { value: 'running', label: 'Running', color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  { value: 'failed', label: 'Failed', color: 'bg-red-500/20 text-red-300 border-red-500/30' },
  { value: 'complete', label: 'Complete', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
];

const AGENT_CHIPS: { value: AgentType; label: string; emoji: string }[] = (
  Object.entries(AGENT_DISPLAY) as [AgentType, { emoji: string; label: string }][]
).map(([value, { emoji, label }]) => ({ value, emoji, label }));

/** Map StatusFilter to actual AgentStatus values */
export function statusFilterToStatuses(filter: StatusFilter): AgentStatus[] {
  switch (filter) {
    case 'running': return ['planning', 'executing'];
    case 'failed': return ['failed'];
    case 'complete': return ['complete'];
  }
}

interface FilterChipsProps {
  activeAgentTypes: AgentType[];
  activeStatuses: StatusFilter[];
  onToggleAgentType: (agentType: AgentType) => void;
  onToggleStatus: (status: StatusFilter) => void;
  onClear: () => void;
}

export function FilterChips({ activeAgentTypes, activeStatuses, onToggleAgentType, onToggleStatus, onClear }: FilterChipsProps) {
  const hasActiveFilters = activeAgentTypes.length > 0 || activeStatuses.length > 0;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* Agent type chips */}
      {AGENT_CHIPS.map((chip) => (
        <button
          key={chip.value}
          onClick={() => onToggleAgentType(chip.value)}
          className={cn(
            'flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors lg:min-h-0 lg:min-w-0',
            activeAgentTypes.includes(chip.value)
              ? 'border-primary bg-primary/20 text-primary'
              : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
          )}
        >
          {chip.emoji && <span>{chip.emoji}</span>}
          {chip.label}
        </button>
      ))}

      <span className="mx-0.5 h-4 w-px bg-zinc-700" />

      {/* Status chips */}
      {STATUS_CHIPS.map((chip) => (
        <button
          key={chip.value}
          onClick={() => onToggleStatus(chip.value)}
          className={cn(
            'min-h-11 min-w-11 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors lg:min-h-0 lg:min-w-0',
            activeStatuses.includes(chip.value)
              ? chip.color + ' border-current'
              : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
          )}
        >
          {chip.label}
        </button>
      ))}

      {/* Clear button */}
      {hasActiveFilters && (
        <button
          onClick={onClear}
          className="ml-1 min-h-11 min-w-11 rounded-full border border-zinc-600 px-2 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 lg:min-h-0 lg:min-w-0"
        >
          Clear
        </button>
      )}
    </div>
  );
}
