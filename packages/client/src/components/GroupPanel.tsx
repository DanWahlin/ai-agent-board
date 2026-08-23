import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Layers, Play, Square, RotateCcw,
  ChevronRight,
} from 'lucide-react';
import type { Task, AgentStatus } from '@/types';
import type { TaskGroupWithChildren } from '@/lib/api';
import { AGENT_DISPLAY } from '@/lib/agent-config';
import { computeGroupStatus, statusIcon } from '@/lib/group-utils';
import { cn, formatDuration } from '@/lib/utils';

interface GroupPanelProps {
  group: TaskGroupWithChildren | null;
  onClose: () => void;
  onRunGroup: (id: string) => void;
  onStopGroup: (id: string) => void;
  onRetryChild: (taskId: string) => void;
  onChildClick: (task: Task) => void;
}

function statusLabel(status: AgentStatus): string {
  switch (status) {
    case 'executing': return 'Running';
    case 'planning': return 'Planning';
    case 'complete': return 'Complete';
    case 'failed': return 'Failed';
    default: return 'Pending';
  }
}

export function GroupPanel({ group, onClose, onRunGroup, onStopGroup, onRetryChild, onChildClick }: GroupPanelProps) {
  const status = useMemo(() => group ? computeGroupStatus(group.children) : null, [group]);

  if (!group || !status) return null;

  const isRunning = status.executing > 0 || status.planning > 0;
  const pct = status.total > 0 ? (status.completed / status.total) * 100 : 0;
  const elapsed = group.startedAt ? Date.now() - group.startedAt : 0;

  return (
    <AnimatePresence>
      <motion.div
        key="group-panel"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className="fixed inset-0 z-[60] flex w-full flex-col bg-zinc-900 shadow-2xl pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] lg:inset-auto lg:right-0 lg:top-0 lg:h-full lg:max-w-md lg:border-l lg:border-zinc-700"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <Layers className="h-5 w-5 shrink-0 text-blue-400" />
            <h2 className="truncate text-sm font-semibold text-zinc-100">{group.title}</h2>
          </div>
          <div className="flex items-center gap-2">
            {!isRunning && status.idle > 0 && (
              <button
                onClick={() => onRunGroup(group.id)}
                className="flex min-h-11 items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 lg:min-h-0"
              >
                <Play className="h-3 w-3" /> Run
              </button>
            )}
            {isRunning && (
              <button
                onClick={() => onStopGroup(group.id)}
                className="flex min-h-11 items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 lg:min-h-0"
              >
                <Square className="h-3 w-3" /> Stop All
              </button>
            )}
            <button onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 lg:h-auto lg:w-auto lg:p-1">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Progress summary */}
        <div className="border-b border-zinc-700/50 px-4 py-3">
          <div className="flex items-center justify-between text-xs text-zinc-400 mb-1.5">
            <span>{status.completed}/{status.total} complete</span>
            {isRunning && elapsed > 0 && (
              <span className="text-blue-400">⏱ {formatDuration(elapsed)}</span>
            )}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-700">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                status.failed > 0 && status.completed === 0 ? 'bg-red-500' :
                status.completed === status.total ? 'bg-emerald-500' : 'bg-blue-500',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-500">
            {status.executing > 0 && <span className="text-blue-400">⚡ {status.executing} running</span>}
            {status.planning > 0 && <span className="text-purple-400">🧠 {status.planning} planning</span>}
            {status.completed > 0 && <span className="text-emerald-400">✓ {status.completed} done</span>}
            {status.failed > 0 && <span className="text-red-400">✕ {status.failed} failed</span>}
            {status.idle > 0 && <span>{status.idle} pending</span>}
          </div>
          {group.description && (
            <p className="mt-2 text-xs text-zinc-500">{group.description}</p>
          )}
        </div>

        {/* Child task list */}
        <div className="flex-1 overflow-y-auto">
          {group.children.map((child, idx) => {
            const agentDisplay = AGENT_DISPLAY[child.agentType as keyof typeof AGENT_DISPLAY];
            const duration = child.completedAt && child.startedAt
              ? formatDuration(child.completedAt - child.startedAt) : null;
            const elapsed = child.startedAt && !child.completedAt
              ? formatDuration(Date.now() - child.startedAt) : null;

            return (
              <div
                key={child.id}
                className={cn(
                  'flex items-center gap-3 border-b border-zinc-800 px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors',
                  child.agentStatus === 'executing' && 'bg-blue-500/5',
                  child.agentStatus === 'failed' && 'bg-red-500/5',
                )}
                onClick={() => onChildClick(child)}
              >
                {/* Order number */}
                <span className="text-xs font-medium text-zinc-600 w-4 text-right">{idx + 1}</span>

                {/* Status icon */}
                {statusIcon(child.agentStatus)}

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-zinc-200">{child.title}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
                    <span>{agentDisplay?.emoji} {agentDisplay?.label}</span>
                    <span>· {statusLabel(child.agentStatus)}</span>
                    {duration && <span>· {duration}</span>}
                    {elapsed && <span className="text-blue-400">· {elapsed}</span>}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1">
                  {child.agentStatus === 'failed' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onRetryChild(child.id); }}
                      className="flex h-11 w-11 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-amber-400 lg:h-auto lg:w-auto lg:p-1"
                      title="Retry"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <ChevronRight className="h-4 w-4 text-zinc-600" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer info */}
        <div className="border-t border-zinc-700 px-4 py-2 text-xs text-zinc-500">
          {group.repoPath && <span>📁 {group.repoPath}</span>}
          {group.baseBranch && <span> · 🌿 {group.baseBranch}</span>}
          <span> · Concurrency: {group.maxConcurrency}</span>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
