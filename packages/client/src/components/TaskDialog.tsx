import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  ChevronDown,
} from 'lucide-react';
import type { Task, TaskAttachment, ColumnId, AgentType, AgentInfo, Priority } from '@/types';
import { AGENT_OPTIONS } from '@/lib/agent-config';
import { PRIORITY_OPTIONS } from '@/lib/priority-config';
import { cn, getRepoPathHelpText, getRepoPathPlaceholder, isAbsoluteRepoPath, slugify } from '@/lib/utils';
import { getRecentRepoPaths, addRepoPath } from '@/lib/repo-history';
import { api } from '@/lib/api';
import ImageUpload from './ImageUpload';

interface TaskDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (task: { title: string; description: string; priority: Priority; columnId: ColumnId; agentType: AgentType; autoRun?: boolean; repoPath?: string; branchName?: string; baseBranch?: string; useWorktree?: boolean; timeoutMinutes?: number }) => Promise<unknown>;
  /** When set, dialog is in edit mode with pre-populated fields */
  editTask?: Task | null;
  /** Called on save in edit mode */
  onEditSubmit?: (id: string, updates: { title: string; description: string; priority: Priority; agentType: AgentType; repoPath?: string; branchName?: string; baseBranch?: string; useWorktree?: boolean; timeoutMinutes?: number }) => Promise<unknown>;
  /** When true, highlight missing required fields (e.g. opened from Play button) */
  highlightRequired?: boolean;
  /** Project-level repo path that cannot be changed per task. */
  lockedRepoPath?: string;
  /** Project-level task defaults used to prefill create mode (each overridable). */
  projectDefaults?: {
    defaultAgentType?: AgentType;
    defaultPriority?: Priority;
    defaultBaseBranch?: string;
    defaultUseWorktree?: boolean;
  };
}

const agents = AGENT_OPTIONS;
const priorities = PRIORITY_OPTIONS;

export function TaskDialog({ open, onClose, onSubmit, editTask, onEditSubmit, highlightRequired, lockedRepoPath, projectDefaults }: TaskDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [agentType, setAgentType] = useState<AgentType>('copilot');
  const [showPriority, setShowPriority] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const [repoPath, setRepoPath] = useState('');
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [useWorktree, setUseWorktree] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pathError, setPathError] = useState('');
  const [pendingImages, setPendingImages] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<TaskAttachment[]>([]);
  const [availableAgents, setAvailableAgents] = useState<AgentInfo[]>([]);

  const isEditMode = !!editTask;
  const hasLockedRepoPath = !!lockedRepoPath;

  const defaultAgent = projectDefaults?.defaultAgentType ?? 'copilot';
  const defaultPriority = projectDefaults?.defaultPriority ?? 'medium';
  const defaultBaseBranch = projectDefaults?.defaultBaseBranch ?? 'main';
  const defaultUseWorktree = projectDefaults?.defaultUseWorktree ?? false;

  // Pre-populate fields when editing
  useEffect(() => {
    if (editTask && open) {
      setTitle(editTask.title);
      setDescription(editTask.description);
      setPriority(editTask.priority || 'medium');
      setAgentType(editTask.agentType || 'copilot');
      setRepoPath(lockedRepoPath || editTask.repoPath || '');
      setBranchName(editTask.branchName || `task/${slugify(editTask.title)}`);
      setBaseBranch(editTask.baseBranch || 'main');
      setUseWorktree(editTask.useWorktree ?? false);
      setTimeoutMinutes(editTask.timeoutMinutes?.toString() ?? '');
      // Load attachments from server
      api.getAttachments(editTask.id).then(setExistingAttachments).catch(() => setExistingAttachments([]));
      // Highlight missing path if opened via Play button
      if (highlightRequired && !editTask.repoPath) {
        setPathError('Local path is required to run the agent');
      }
    } else if (open && !editTask) {
      // Opening in create mode — prefill from project defaults (each overridable)
      setPriority(defaultPriority);
      setAgentType(defaultAgent);
      setBaseBranch(defaultBaseBranch);
      setUseWorktree(defaultUseWorktree);
    } else if (!open) {
      // Reset when dialog closes
      setTitle('');
      setDescription('');
      setPriority('medium');
      setAgentType('copilot');
      setShowPriority(false);
      setShowAgent(false);
      setAutoRun(false);
      setRepoPath('');
      setBranchName('');
      setBaseBranch('main');
      setUseWorktree(false);
      setTimeoutMinutes('');
      setSubmitting(false);
      setPathError('');
      setPendingImages([]);
      setExistingAttachments([]);
    }
  }, [editTask, open, highlightRequired, lockedRepoPath, defaultAgent, defaultPriority, defaultBaseBranch, defaultUseWorktree]);

  useEffect(() => {
    if (open && lockedRepoPath) {
      setRepoPath(lockedRepoPath);
      setPathError('');
    }
  }, [open, lockedRepoPath]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    api.getAgents()
      .then((result) => {
        if (cancelled) return;
        setAvailableAgents(result);

        const selectedInfo = result.find((agent) => agent.name === agentType);
        const firstAvailable = result.find((agent) => agent.available);
        // Don't auto-swap when the project configures a default agent — respect the choice.
        if (!editTask && !projectDefaults?.defaultAgentType && selectedInfo && !selectedInfo.available && firstAvailable) {
          setAgentType(firstAvailable.name);
        }
      })
      .catch(() => {
        if (!cancelled) setAvailableAgents([]);
      });

    return () => {
      cancelled = true;
    };
  }, [open, editTask, agentType, projectDefaults?.defaultAgentType]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || submitting) return;

    // Client-side path validation — required
    const trimmedPath = (lockedRepoPath || repoPath).trim();
    if (!trimmedPath) {
      setPathError('Local path is required');
      return;
    }
    if (!isAbsoluteRepoPath(trimmedPath)) {
      setPathError('Path must be absolute (use /, ~, D:\\, or \\\\server\\share)');
      return;
    }
    setPathError('');

    // Auto-generate branch name from title if using worktree and no custom name set
    const effectiveBranch = useWorktree
      ? (branchName.trim() || `task/${slugify(title.trim())}`)
      : undefined;

    const repoFields = {
      repoPath: trimmedPath,
      branchName: effectiveBranch,
      baseBranch: baseBranch.trim() || 'main',
      useWorktree,
      timeoutMinutes: timeoutMinutes === '' ? undefined : Number(timeoutMinutes),
    };

    setSubmitting(true);
    try {
      if (isEditMode && onEditSubmit) {
        if (!hasLockedRepoPath) addRepoPath(trimmedPath);
        const result = await onEditSubmit(editTask!.id, {
          title: title.trim(),
          description: description.trim(),
          priority,
          agentType,
          ...repoFields,
        });
        if (result === undefined) return; // Server error — keep dialog open
      } else {
        if (!hasLockedRepoPath) addRepoPath(trimmedPath);
        const result = await onSubmit({
          title: title.trim(),
          description: description.trim(),
          priority,
          columnId: autoRun ? 'in-progress' : 'backlog',
          agentType,
          autoRun: autoRun || undefined,
          ...repoFields,
        }) as Task | undefined;
        if (result === undefined) return; // Server error — keep dialog open

        // Upload pending images after task creation
        if (pendingImages.length > 0 && result?.id) {
          try {
            await api.uploadAttachments(result.id, pendingImages);
          } catch (uploadErr) {
            console.warn('Failed to upload images for new task', result.id, uploadErr);
          }
        }
      }

      // Success — reset and close
      setTitle('');
      setDescription('');
      setPriority(defaultPriority);
      setAgentType(defaultAgent);
      setAutoRun(false);
      setRepoPath('');
      setBranchName('');
      setBaseBranch(defaultBaseBranch);
      setUseWorktree(defaultUseWorktree);
      setTimeoutMinutes('');
      setPendingImages([]);
      setExistingAttachments([]);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  // Close dropdowns on outside click
  const priorityRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showPriority && !showAgent) return;
    const handleClick = (e: MouseEvent) => {
      if (showPriority && priorityRef.current && !priorityRef.current.contains(e.target as Node)) {
        setShowPriority(false);
      }
      if (showAgent && agentRef.current && !agentRef.current.contains(e.target as Node)) {
        setShowAgent(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPriority, showAgent]);

  const selectedAgent = agents.find((a) => a.value === agentType)!;
  const selectedPriority = priorities.find((p) => p.value === priority)!;
  const agentAvailability = new Map(availableAgents.map((agent) => [agent.name, agent]));
  const selectedAgentInfo = agentAvailability.get(agentType);
  const repoPathPlaceholder = getRepoPathPlaceholder();
  const repoPathHelpText = getRepoPathHelpText();

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />

          {/* Dialog */}
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-2xl max-h-[90vh] flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold">{isEditMode ? 'Edit Task' : 'Create Task'}</h2>
              <button
                onClick={onClose}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-1 min-h-0 flex-col">
              <div className="space-y-4 overflow-y-auto flex-1 min-h-0 px-1">
              {/* Title */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What needs to be done?"
                  autoFocus
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              {/* Description */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the task for the selected agent..."
                  rows={4}
                  className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              {/* Image attachments */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Images
                </label>
                <ImageUpload
                  taskId={isEditMode ? editTask!.id : undefined}
                  existing={existingAttachments}
                  onPendingChange={setPendingImages}
                  onAttachmentsChange={setExistingAttachments}
                />
              </div>

              {/* Priority */}
              <div className="relative" ref={priorityRef}>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Priority
                </label>
                <button
                  type="button"
                  onClick={() => setShowPriority(!showPriority)}
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm hover:bg-accent transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <span>{selectedPriority.emoji}</span>
                    {selectedPriority.label}
                  </span>
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', showPriority && 'rotate-180')} />
                </button>

                <AnimatePresence>
                  {showPriority && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
                    >
                      {priorities.map((p) => (
                        <button
                          key={p.value}
                          type="button"
                          onClick={() => {
                            setPriority(p.value);
                            setShowPriority(false);
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors',
                            priority === p.value && 'bg-accent'
                          )}
                        >
                          <span>{p.emoji}</span>
                          {p.label}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Agent */}
              <div className="relative" ref={agentRef}>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Agent
                </label>
                <button
                  type="button"
                  onClick={() => setShowAgent(!showAgent)}
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm hover:bg-accent transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <span>{selectedAgent.emoji}</span>
                    {selectedAgent.label}
                    {selectedAgentInfo && !selectedAgentInfo.available && (
                      <span className="text-xs text-red-500">Unavailable</span>
                    )}
                  </span>
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', showAgent && 'rotate-180')} />
                </button>

                <AnimatePresence>
                  {showAgent && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
                    >
                      {agents.map((a) => {
                        const info = agentAvailability.get(a.value);
                        const unavailable = info?.available === false;
                        return (
                          <button
                            key={a.value}
                            type="button"
                            disabled={unavailable}
                            onClick={() => {
                              setAgentType(a.value);
                              setShowAgent(false);
                            }}
                            className={cn(
                              'flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                              agentType === a.value && 'bg-accent'
                            )}
                            title={unavailable ? info?.reason || `${a.label} is unavailable` : undefined}
                          >
                            <span>{a.emoji}</span>
                            <span className="flex-1 text-left">{a.label}</span>
                            {info && (
                              <span className={cn(
                                'text-[10px]',
                                info.available ? 'text-emerald-500' : 'text-red-500'
                              )}>
                                {info.available ? 'Available' : info.reason || 'Unavailable'}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div>
                <label htmlFor="task-timeout-minutes" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Time limit (minutes)
                </label>
                <input
                  id="task-timeout-minutes"
                  type="number"
                  min={1}
                  max={240}
                  step={1}
                  value={timeoutMinutes}
                  onChange={(e) => setTimeoutMinutes(e.target.value)}
                  placeholder="60 (server default)"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p className="mt-1 text-xs text-muted-foreground/60">
                  Leave blank for the server default. Deep reviews can use up to 240 minutes.
                </p>
              </div>

              {/* Auto-run (create mode only) */}
              {!isEditMode && (
                <label className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={autoRun}
                    onChange={(e) => setAutoRun(e.target.checked)}
                    className="h-4 w-4 cursor-pointer rounded border-border accent-primary"
                  />
                  <span className="text-sm text-muted-foreground">
                    Auto-run — start agent immediately after creating
                  </span>
                </label>
              )}

              {/* Repository configuration */}
              <div className="space-y-3 rounded-lg border border-border/50 bg-muted/30 p-3">
                <div>
                  <label htmlFor="task-repo-path" className="mb-1 block text-xs font-medium text-muted-foreground">
                    Local Path <span className="text-red-400">*</span>
                  </label>
                    <input
                      id="task-repo-path"
                      type="text"
                      value={repoPath}
                      onChange={(e) => {
                        if (hasLockedRepoPath) return;
                        setRepoPath(e.target.value);
                        setPathError('');
                      }}
                      placeholder={repoPathPlaceholder}
                      list={hasLockedRepoPath ? undefined : 'task-recent-repo-paths'}
                      readOnly={hasLockedRepoPath}
                      aria-readonly={hasLockedRepoPath}
                      className={`w-full rounded-lg border bg-background px-3 py-1.5 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none ${
                        hasLockedRepoPath
                          ? 'border-border text-muted-foreground'
                          : pathError ? 'border-red-500 focus:border-red-500' : 'border-border focus:border-primary'
                      }`}
                    />
                    {pathError && (
                      <p className="mt-1 text-xs text-red-500">{pathError}</p>
                    )}
                    {!pathError && (
                      <p className="mt-1 text-xs text-muted-foreground/60">
                        {hasLockedRepoPath ? 'Locked to this Project local path.' : repoPathHelpText}
                      </p>
                    )}
                    {!hasLockedRepoPath && (
                      <datalist id="task-recent-repo-paths">
                        {getRecentRepoPaths().map((p) => <option key={p} value={p} />)}
                      </datalist>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Base Branch</label>
                      <input
                        type="text"
                        value={baseBranch}
                        onChange={(e) => setBaseBranch(e.target.value)}
                        placeholder="main"
                        className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none"
                      />
                    </div>
                    <div className="flex items-end pb-1">
                      <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={useWorktree}
                          onChange={(e) => setUseWorktree(e.target.checked)}
                          className="rounded border-border"
                        />
                        Use Git Worktree
                      </label>
                    </div>
                  </div>
                  {useWorktree && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Branch Name</label>
                      <input
                        type="text"
                        value={branchName}
                        onChange={(e) => setBranchName(e.target.value)}
                        placeholder={title.trim() ? `task/${slugify(title.trim())}` : 'task/my-feature'}
                        className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-mono placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none"
                      />
                      <p className="mt-0.5 text-[10px] text-muted-foreground/60">Leave blank to auto-generate from title</p>
                    </div>
                  )}
                </div>

              </div>

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-4 mt-2 border-t border-border shrink-0">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!title.trim() || submitting}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {submitting ? 'Saving…' : isEditMode ? 'Save Changes' : 'Create Task'}
                </button>
              </div>
            </form>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
