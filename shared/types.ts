export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type ColumnId = 'backlog' | 'in-progress' | 'review' | 'done';
export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete' | 'failed';
export type AgentType = 'copilot' | 'claude' | 'codex' | 'opencode' | 'hermes' | 'openclaw' | 'grok';
export type ThinkingEffort = 'low' | 'medium' | 'high';
export type RoleId = 'orchestrator' | 'research' | 'implementor' | 'reviewer' | 'knowledge';

export type SessionState = 'Ready' | 'Running' | 'Waiting' | 'Completed' | 'Failed';
export type SessionStateAction = 'noop' | 'start' | 'wait' | 'resume' | 'complete' | 'fail';

export interface SessionStateTransition {
  from: SessionState;
  to: SessionState;
  action: SessionStateAction;
}

export interface SessionStateError {
  code: 'invalid_state' | 'invalid_transition' | 'terminal_state_immutable';
  from: unknown;
  to: unknown;
  message: string;
}

export type SessionStateResult =
  | { ok: true; state: SessionState; transition: SessionStateTransition }
  | { ok: false; error: SessionStateError };

export type SessionResultOutcome = 'success' | 'failure';

export interface SessionRecentResult {
  sessionId: string;
  outcome: SessionResultOutcome;
  completedAt: number;
  summary: string | null;
  error: string | null;
}

export interface TaskSessionAssociation {
  taskId: string;
  /** Latest admitted business Session, including a terminal Session; null means never executed. */
  currentSessionId: string | null;
  /** Latest terminal result; null means no terminal result has been recorded. */
  recentResult: SessionRecentResult | null;
}

export interface Session {
  /** Independent business identity; never use taskId as the Session ID. */
  id: string;
  taskId: string;
  state: SessionState;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Frozen Phase 2.2 selection; null is valid for legacy/unconfigured execution. */
  roleExecutionSnapshot: RoleExecutionSnapshot | null;
  /** Optional link to the immutable orchestration request snapshot. */
  executionAttemptId: string | null;
  /** Optional provider SDK identity; absent until Phase 4 adapts a real SDK session. */
  sdkSessionId: string | null;
}

export interface CreateSessionInput {
  id: string;
  taskId: string;
  createdAt: number;
  roleExecutionSnapshot?: RoleExecutionSnapshot | null;
  executionAttemptId?: string | null;
  sdkSessionId?: string | null;
}

export interface SessionResultInput {
  outcome: SessionResultOutcome;
  completedAt: number;
  summary?: string | null;
  error?: string | null;
}

export interface SessionContractError {
  code:
    | 'invalid_type'
    | 'required'
    | 'blank'
    | 'duplicate_id'
    | 'same_as_task'
    | 'task_not_active'
    | 'task_mismatch'
    | 'concurrent_session'
    | 'invalid_transition'
    | 'terminal_state_immutable'
    | 'invalid_result'
    | 'result_already_recorded'
    | 'stale_session_result';
  path: string;
  message: string;
}

export type SessionContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: SessionContractError[] };

/** New domain lifecycle, serialized with exact title case per Phase 2.1. */
export type TaskLifecycleState = 'Draft' | 'Inbox' | 'Active' | 'Done';

export type TaskLifecycleAction =
  | 'noop'
  | 'submit'
  | 'withdraw'
  | 'qualify'
  | 'retry'
  | 'complete'
  | 'reopen';

export interface TaskLifecycleTransition {
  from: TaskLifecycleState;
  to: TaskLifecycleState;
  action: TaskLifecycleAction;
  /** Active → Done is never inferred from an AgentStatus or Session result. */
  requiresCompletionConfirmation?: boolean;
}

/** Explicit caller confirmation required for Task lifecycle completion. */
export interface TaskLifecycleTransitionContext {
  completionConfirmed?: boolean;
}

export interface TaskLifecycleError {
  code: 'invalid_state' | 'invalid_transition' | 'completion_confirmation_required';
  from: unknown;
  to: unknown;
  message: string;
}

export type TaskLifecycleResult =
  | { ok: true; state: TaskLifecycleState; transition: TaskLifecycleTransition }
  | { ok: false; error: TaskLifecycleError };

/** Domain terminology; preserves every existing AgentType wire value. */
export type ProviderType = AgentType;

export interface RoleExecutionConfig {
  provider: ProviderType;
  /** null selects the provider default; a string is scoped to this provider. */
  model: string | null;
}

export interface Role {
  /** Opaque, stable identity assigned by the caller, never derived from the name. */
  id: string;
  name: string;
  responsibility: string;
  instructions: string;
  execution: RoleExecutionConfig;
}

export interface CreateRoleInput {
  name: string;
  responsibility: string;
  instructions: string;
  execution: { provider: ProviderType; model?: string | null };
}

export interface UpdateRoleInput {
  name?: string;
  responsibility?: string;
  instructions?: string;
  execution?: { provider?: ProviderType; model?: string | null };
}

/** Selection snapshot, not a business Session or an SDK Session. */
export interface RoleExecutionSnapshot {
  readonly roleId: string;
  readonly name: string;
  readonly responsibility: string;
  readonly instructions: string;
  readonly execution: Readonly<RoleExecutionConfig>;
}

export interface RoleContractError {
  /** Dotted field path; an empty path denotes the input object itself. */
  path: string;
  code: 'required' | 'invalid_type' | 'blank' | 'unknown_field' | 'unknown_provider';
  message: string;
}

export type RoleContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: RoleContractError[] };

export interface AgentInfo {
  name: AgentType;
  displayName: string;
  available: boolean;
  version?: string;
  reason?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  columnId: ColumnId;
  agentStatus: AgentStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  repoPath?: string;
  branchName?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  worktreePath?: string;
  agentType?: AgentType;
  archived?: boolean;
  groupId?: string;
  groupOrder?: number;
  attachments?: TaskAttachment[];
  projectId: string;
  summary?: string | null;
  runRequestedAt?: number;
  runClaimedAt?: number;
  externalSource?: string;
  externalKey?: string;
  provenance?: TaskProvenance;
  /** Optional execution limit for this task. Omit to use the server default. */
  timeoutMinutes?: number | null;
  /** Additive Phase 2.4 association; legacy Task fields remain authoritative until an adapter is defined. */
  session?: TaskSessionAssociation;
}

/** A first-class link between two durable Board work items. */
export interface TaskRelationship {
  taskId: string;
  relatedTaskId: string;
  type: 'related';
  createdAt: number;
}

/** Immutable request snapshot for one execution of a durable Board card. */
export interface ExecutionAttempt {
  id: string;
  taskId: string;
  externalSource: string;
  externalKey: string;
  titleSnapshot: string;
  descriptionSnapshot: string;
  agentType: AgentType;
  relatedTaskId?: string;
  autoStart: boolean;
  timeoutMinutes?: number | null;
  /** Canonical JSON of every material orchestration request field. */
  requestSnapshot: string;
  status: 'pending' | 'dispatched';
  createdAt: number;
  /** Optional business Session link; old attempts remain valid when absent. */
  sessionId?: string | null;
}

export interface TaskProvenance {
  sourceProfile?: string;
  sourcePlatform?: string;
  sourceSession?: string;
  sourceMessage?: string;
  sourceTask?: string;
  requestedBy?: string;
  origin?: Record<string, string | number | boolean | null>;
}

export interface TaskGroup {
  id: string;
  title: string;
  description?: string;
  priority: Priority;
  columnId: ColumnId;
  repoPath?: string;
  baseBranch?: string;
  maxConcurrency: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  archived?: boolean;
  projectId: string;
}

export interface ProjectTaskCounts {
  backlog: number;
  'in-progress': number;
  review: number;
  done: number;
  total: number;
}

export interface Project {
  id: string;
  name: string;
  repoPath?: string;
  /** Source GitHub/git URL the project's local repo was cloned from, if any. */
  repoUrl?: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  taskCounts?: ProjectTaskCounts;
  /** Default task properties for this project. Each is overridable per task. */
  defaultAgentType?: AgentType;
  defaultPriority?: Priority;
  defaultBaseBranch?: string;
  defaultUseWorktree?: boolean;
  aliases?: string[];
}

export interface CreateProjectRequest {
  name?: string;
  repoPath?: string;
  /** When provided, the server clones this git URL into the configured clone root and uses it as repoPath. */
  repoUrl?: string;
  defaultAgentType?: AgentType;
  defaultPriority?: Priority;
  defaultBaseBranch?: string;
  defaultUseWorktree?: boolean;
  aliases?: string[];
}

export interface UpdateProjectRequest {
  name?: string;
  repoPath?: string | null;
  repoUrl?: string | null;
  defaultAgentType?: AgentType | null;
  defaultPriority?: Priority | null;
  defaultBaseBranch?: string | null;
  defaultUseWorktree?: boolean | null;
  aliases?: string[];
}

/** Server-side Agent Board configuration (persisted to the config file). */
export interface ProjectConfig {
  /** Absolute path under which repos cloned from a URL are placed. */
  cloneRoot: string;
}

/** Settings for one installed execution capability. CLI details are configuration, not a role definition. */
export interface ProviderConfig {
  id: AgentType;
  displayName: string;
  enabled: boolean;
  cliCommand: string;
  commandArgs: string[];
  models: string[];
  defaultModel?: string;
  capabilities: string[];
}

export interface ProviderValidation extends ProviderConfig {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface RoleBinding {
  providerId: AgentType;
  model: string;
  thinking: ThinkingEffort;
}

/** Global default binding and instructions for a stable built-in role. */
export interface RoleConfig {
  id: RoleId;
  displayName: string;
  binding: RoleBinding;
  instructions: string;
  /** Provider-specific instructions loaded for the active binding when available. */
  providerInstructions?: Partial<Record<AgentType, string>>;
}

/** Per-run changes; omitted fields inherit the global Role binding. */
export interface RoleBindingOverride {
  providerId?: AgentType;
  model?: string;
  thinking?: ThinkingEffort;
}

/** Immutable binding captured when a task or handoff starts. */
export interface RoleExecutionSnapshot {
  roleId: RoleId;
  roleName: string;
  binding: RoleBinding;
  instructions: string;
  capturedAt: number;
}

/** Persistent Settings payload. Runtime overrides are intentionally excluded. */
export interface SettingsConfig extends ProjectConfig {
  providers: ProviderConfig[];
  roles: RoleConfig[];
}

/** Settings returned to clients, enriched with the latest CLI/SDK availability check. */
export interface SettingsResponse extends SettingsConfig {
  providerValidation: ProviderValidation[];
}

export interface ProjectPathValidation {
  repoPath: string;
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  error?: string;
  warning?: string;
}

export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command'
  | 'command_output'
  | 'output'
  | 'test_result'
  | 'error'
  | 'complete';

export interface AgentEvent {
  id: string;
  taskId: string;
  type: AgentEventType;
  content: string;
  timestamp: number;
  metadata?: {
    file?: string;
    fileEventType?: string;
    language?: string;
    command?: string;
    diff?: string;
    agentType?: AgentType;
    duration?: number;
    error?: string;
    /** Persisted, complete assistant prose used by service integrations. */
    finalOutput?: boolean;
  };
}

export interface Column {
  id: ColumnId;
  title: string;
  color: string;
  icon: string;
}

export interface AgentCompletePayload {
  taskId: string;
  status: 'complete' | 'failed';
  agentType?: AgentType;
  duration: number;
  eventCount: number;
}

export interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  description: string;
  priority: Priority;
  agentType: AgentType;
  repoPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  createdAt: number;
}

export interface AgentFollowUpPayload {
  taskId: string;
  message: string;
  attachmentIds?: string[];
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export type WSMessage =
  | { type: 'agent_event'; payload: AgentEvent }
  | { type: 'task_updated'; payload: Task }
  | { type: 'task_deleted'; payload: { id: string } }
  | { type: 'agent_complete'; payload: AgentCompletePayload }
  | { type: 'agent_follow_up'; payload: AgentFollowUpPayload }
  | { type: 'group_updated'; payload: TaskGroup }
  | { type: 'project_updated'; payload: Project }
  | { type: 'project_deleted'; payload: { id: string } };
