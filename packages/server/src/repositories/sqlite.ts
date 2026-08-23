import Database from 'better-sqlite3';
import type { Task, Priority, ColumnId, AgentStatus, AgentType, AgentEvent, TaskRelationship, ExecutionAttempt } from '../types.js';
import type { TaskRepository, ContinuationEligibility } from './types.js';
import { errorMessage } from '../utils.js';

interface TaskRow {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  column_id: ColumnId;
  agent_status: AgentStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  repo_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  use_worktree: number | null;
  worktree_path: string | null;
  agent_type: AgentType;
  archived: number;
  project_id: string;
  group_id: string | null;
  group_order: number | null;
  summary: string | null;
  external_source: string | null; external_key: string | null; provenance: string | null;
  run_requested_at: number | null; run_claimed_at: number | null;
  timeout_minutes: number | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    columnId: row.column_id,
    agentStatus: row.agent_status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    repoPath: row.repo_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    useWorktree: row.use_worktree != null ? Boolean(row.use_worktree) : undefined,
    worktreePath: row.worktree_path ?? undefined,
    agentType: row.agent_type,
    archived: Boolean(row.archived),
    groupId: row.group_id ?? undefined,
    groupOrder: row.group_order ?? undefined,
    summary: row.summary ?? null,
    externalSource: row.external_source ?? undefined, externalKey: row.external_key ?? undefined,
    provenance: row.provenance ? JSON.parse(row.provenance) : undefined,
    runRequestedAt: row.run_requested_at ?? undefined, runClaimedAt: row.run_claimed_at ?? undefined,
    timeoutMinutes: row.timeout_minutes ?? undefined,
  };
}

interface AttemptRow {
  id: string; task_id: string; external_source: string; external_key: string;
  title_snapshot: string; description_snapshot: string; agent_type: AgentType;
  related_task_id: string | null; auto_start: number; timeout_minutes: number | null;
  request_snapshot: string;
  status: ExecutionAttempt['status']; created_at: number;
}

function rowToAttempt(row: AttemptRow): ExecutionAttempt {
  return { id: row.id, taskId: row.task_id, externalSource: row.external_source, externalKey: row.external_key,
    titleSnapshot: row.title_snapshot, descriptionSnapshot: row.description_snapshot, agentType: row.agent_type,
    relatedTaskId: row.related_task_id ?? undefined, autoStart: Boolean(row.auto_start),
    timeoutMinutes: row.timeout_minutes ?? undefined, requestSnapshot: row.request_snapshot,
    status: row.status, createdAt: row.created_at };
}

export class SqliteTaskRepository implements TaskRepository {
  private db: Database.Database;
  private stmts: {
    getAll: Database.Statement;
    getAllIncludingArchived: Database.Statement;
    getArchived: Database.Statement;
    getById: Database.Statement;
    insert: Database.Statement;
    update: Database.Statement;
    delete: Database.Statement;
    count: Database.Statement;
    insertEvent: Database.Statement;
    getEventsByTaskId: Database.Statement;
    deleteEventsByTaskId: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.stmts = {
      getAll: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND archived = 0 AND group_id IS NULL ORDER BY created_at ASC'),
      getAllIncludingArchived: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND group_id IS NULL ORDER BY created_at ASC'),
      getArchived: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND archived = 1 ORDER BY created_at DESC'),
      getById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
      insert: db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at, started_at, completed_at,
          repo_path, branch_name, base_branch, use_worktree, worktree_path, archived, group_id, group_order, summary, external_source, external_key, provenance, run_requested_at, run_claimed_at, timeout_minutes)
        VALUES (@id, @project_id, @title, @description, @priority, @column_id, @agent_status, @agent_type, @created_at, @started_at, @completed_at,
          @repo_path, @branch_name, @base_branch, @use_worktree, @worktree_path, @archived, @group_id, @group_order, @summary, @external_source, @external_key, @provenance, @run_requested_at, @run_claimed_at, @timeout_minutes)
      `),
      update: db.prepare(`
        UPDATE tasks SET
          title = @title,
          description = @description,
          priority = @priority,
          column_id = @column_id,
          agent_status = @agent_status,
          agent_type = @agent_type,
          started_at = @started_at,
          completed_at = @completed_at,
          repo_path = @repo_path,
          branch_name = @branch_name,
          base_branch = @base_branch,
          use_worktree = @use_worktree,
          worktree_path = @worktree_path,
          archived = @archived,
          summary = @summary, run_requested_at = @run_requested_at, run_claimed_at = @run_claimed_at,
          timeout_minutes = @timeout_minutes
        WHERE id = @id
      `),
      delete: db.prepare('DELETE FROM tasks WHERE id = ?'),
      count: db.prepare('SELECT COUNT(*) as cnt FROM tasks'),
      insertEvent: db.prepare(`
        INSERT INTO events (id, task_id, type, content, timestamp, metadata)
        VALUES (@id, @task_id, @type, @content, @timestamp, @metadata)
      `),
      getEventsByTaskId: db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY timestamp ASC'),
      deleteEventsByTaskId: db.prepare('DELETE FROM events WHERE task_id = ?'),
    };
  }

  async getAll(includeArchived = false, projectId = 'default'): Promise<Task[]> {
    const stmt = includeArchived ? this.stmts.getAllIncludingArchived : this.stmts.getAll;
    return (stmt.all(projectId) as TaskRow[]).map(rowToTask);
  }

  async getById(id: string): Promise<Task | undefined> {
    const row = this.stmts.getById.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async getByExternalIdentity(source: string, key: string): Promise<Task | undefined> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE external_source = ? AND external_key = ?').get(source, key) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async resolve(reference: string, projectId: string): Promise<Task[]> {
    const needle = reference.trim();
    const exact = this.stmts.getById.get(needle) as TaskRow | undefined;
    if (exact) return exact.project_id === projectId ? [rowToTask(exact)] : [];
    return (this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND lower(title) = lower(?) ORDER BY created_at, id').all(projectId, needle) as TaskRow[]).map(rowToTask);
  }

  async create(task: Task): Promise<Task> {
    this.insertTask(task);
    return task;
  }

  private insertTask(task: Task): void {
    this.stmts.insert.run({
      id: task.id,
      project_id: task.projectId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      column_id: task.columnId,
      agent_status: task.agentStatus,
      agent_type: task.agentType ?? 'copilot',
      created_at: task.createdAt,
      started_at: task.startedAt ?? null,
      completed_at: task.completedAt ?? null,
      repo_path: task.repoPath ?? null,
      branch_name: task.branchName ?? null,
      base_branch: task.baseBranch ?? null,
      use_worktree: task.useWorktree != null ? (task.useWorktree ? 1 : 0) : null,
      worktree_path: task.worktreePath ?? null,
      archived: task.archived ? 1 : 0,
      group_id: task.groupId ?? null,
      group_order: task.groupOrder ?? null,
      summary: task.summary ?? null, external_source: task.externalSource ?? null, external_key: task.externalKey ?? null,
      provenance: task.provenance ? JSON.stringify(task.provenance) : null, run_requested_at: task.runRequestedAt ?? null, run_claimed_at: task.runClaimedAt ?? null,
      timeout_minutes: task.timeoutMinutes ?? null,
    });
  }

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    try { await this.create(task); return { task, created: true }; } catch (err) {
      if (task.externalSource && task.externalKey && err instanceof Error && err.message.includes('UNIQUE')) {
        const existing = await this.getByExternalIdentity(task.externalSource, task.externalKey); if (existing) return { task: existing, created: false };
      } throw err;
    }
  }
  async requestRun(id: string, at: number) { this.db.prepare('UPDATE tasks SET run_requested_at=?, run_claimed_at=NULL WHERE id=?').run(at,id); return this.getById(id); }
  async claimRun(id: string, at: number) { const staleBefore=at-30_000; const r=this.db.prepare("UPDATE tasks SET run_claimed_at=? WHERE id=? AND run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < ?) AND agent_status IN ('idle','planning')").run(at,id,staleBefore); return r.changes ? this.getById(id) : undefined; }
  async clearRun(id: string) { this.db.prepare('UPDATE tasks SET run_requested_at=NULL, run_claimed_at=NULL WHERE id=?').run(id); return this.getById(id); }
  async getPendingRuns(staleBefore = Date.now()-30_000) { return (this.db.prepare("SELECT * FROM tasks WHERE run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < ?) AND agent_status IN ('idle','planning') ORDER BY run_requested_at").all(staleBefore) as TaskRow[]).map(rowToTask); }

  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    return this.db.transaction(() => {
      const row = this.stmts.getById.get(id) as TaskRow | undefined;
      const existing = row ? rowToTask(row) : undefined;
      if (!existing) return undefined;
      return this.updateExisting(existing, updates);
    })();
  }

  private updateExisting(existing: Task, updates: Partial<Task>): Task {
      const merged = { ...existing, ...updates };
      this.stmts.update.run({
        id: existing.id,
        title: merged.title,
        description: merged.description,
        priority: merged.priority,
        column_id: merged.columnId,
        agent_status: merged.agentStatus,
        agent_type: merged.agentType,
        started_at: merged.startedAt ?? null,
        completed_at: merged.completedAt ?? null,
        repo_path: merged.repoPath ?? null,
        branch_name: merged.branchName ?? null,
        base_branch: merged.baseBranch ?? null,
        use_worktree: merged.useWorktree != null ? (merged.useWorktree ? 1 : 0) : null,
        worktree_path: merged.worktreePath ?? null,
        archived: merged.archived ? 1 : 0,
        summary: merged.summary ?? null, run_requested_at: merged.runRequestedAt ?? null, run_claimed_at: merged.runClaimedAt ?? null,
        timeout_minutes: merged.timeoutMinutes ?? null,
      });
      return merged;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  async count(): Promise<number> {
    const row = this.stmts.count.get() as { cnt: number };
    return row.cnt;
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    this.stmts.insertEvent.run({
      id: event.id,
      task_id: event.taskId,
      type: event.type,
      content: event.content,
      timestamp: event.timestamp,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    });
  }

  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    const rows = this.stmts.getEventsByTaskId.all(taskId) as Array<{
      id: string;
      task_id: string;
      type: string;
      content: string;
      timestamp: number;
      metadata: string | null;
    }>;
    return rows.map((row) => {
      let metadata: AgentEvent['metadata'] | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch (err: unknown) {
          // Log malformed metadata
          console.warn(`[sqlite] Failed to parse metadata for event ${row.id}:`, errorMessage(err));
        }
      }
      return {
        id: row.id,
        taskId: row.task_id,
        type: row.type as AgentEvent['type'],
        content: row.content,
        timestamp: row.timestamp,
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  async deleteEventsByTaskId(taskId: string): Promise<void> {
    this.stmts.deleteEventsByTaskId.run(taskId);
  }

  async getArchivedTasks(projectId = 'default'): Promise<Task[]> {
    return (this.stmts.getArchived.all(projectId) as TaskRow[]).map(rowToTask);
  }

  async getRelationships(taskId: string): Promise<TaskRelationship[]> {
    const rows = this.db.prepare(`SELECT task_id, related_task_id, type, created_at FROM task_relationships
      WHERE task_id = ? OR related_task_id = ? ORDER BY created_at, task_id, related_task_id`).all(taskId, taskId) as Array<{ task_id: string; related_task_id: string; type: 'related'; created_at: number }>;
    return rows.map((row) => ({ taskId, relatedTaskId: row.task_id === taskId ? row.related_task_id : row.task_id, type: row.type, createdAt: row.created_at }));
  }

  async createRelationship(taskId: string, relatedTaskId: string, createdAt: number): Promise<{ relationship: TaskRelationship; created: boolean }> {
    if (taskId === relatedTaskId) throw new Error('a task cannot be related to itself');
    const [left, right] = taskId < relatedTaskId ? [taskId, relatedTaskId] : [relatedTaskId, taskId];
    const result = this.db.prepare(`INSERT OR IGNORE INTO task_relationships (task_id, related_task_id, type, created_at)
      SELECT ?, ?, 'related', ? FROM tasks a JOIN tasks b ON b.id = ? WHERE a.id = ? AND a.project_id = b.project_id`).run(left, right, createdAt, right, left);
    const row = this.db.prepare('SELECT created_at FROM task_relationships WHERE task_id = ? AND related_task_id = ?').get(left, right) as { created_at: number } | undefined;
    if (!row) throw new Error('tasks must exist in the same project');
    return { relationship: { taskId, relatedTaskId, type: 'related', createdAt: row.created_at }, created: result.changes > 0 };
  }

  async deleteRelationship(taskId: string, relatedTaskId: string): Promise<boolean> {
    const [left, right] = taskId < relatedTaskId ? [taskId, relatedTaskId] : [relatedTaskId, taskId];
    return this.db.prepare('DELETE FROM task_relationships WHERE task_id = ? AND related_task_id = ?').run(left, right).changes > 0;
  }

  async getAttemptById(id: string): Promise<ExecutionAttempt | undefined> {
    const row = this.db.prepare('SELECT * FROM execution_attempts WHERE id=?').get(id) as AttemptRow | undefined;
    return row ? rowToAttempt(row) : undefined;
  }

  async getAttemptByExternalIdentity(source: string, key: string): Promise<ExecutionAttempt | undefined> {
    const row = this.db.prepare('SELECT * FROM execution_attempts WHERE external_source=? AND external_key=?').get(source, key) as AttemptRow | undefined;
    return row ? rowToAttempt(row) : undefined;
  }

  async getAttemptsByTaskId(taskId: string): Promise<ExecutionAttempt[]> {
    return (this.db.prepare('SELECT * FROM execution_attempts WHERE task_id=? ORDER BY created_at,id').all(taskId) as AttemptRow[]).map(rowToAttempt);
  }

  async createAttemptIdempotent(attempt: ExecutionAttempt): Promise<{ attempt: ExecutionAttempt; created: boolean }> {
    const result = this.db.prepare(`INSERT OR IGNORE INTO execution_attempts
      (id,task_id,external_source,external_key,title_snapshot,description_snapshot,agent_type,related_task_id,auto_start,timeout_minutes,request_snapshot,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(attempt.id, attempt.taskId, attempt.externalSource, attempt.externalKey,
        attempt.titleSnapshot, attempt.descriptionSnapshot, attempt.agentType, attempt.relatedTaskId ?? null,
        attempt.autoStart ? 1 : 0, attempt.timeoutMinutes ?? null, attempt.requestSnapshot, attempt.status, attempt.createdAt);
    if (result.changes) return { attempt, created: true };
    const existing = await this.getAttemptByExternalIdentity(attempt.externalSource, attempt.externalKey);
    if (!existing) throw new Error('failed to persist execution attempt');
    return { attempt: existing, created: false };
  }

  async createOrchestration(task: Task, attempt: ExecutionAttempt, relatedTaskId?: string, relationshipCreatedAt = Date.now()) {
    return this.db.transaction(() => {
      const replayRow = this.db.prepare('SELECT * FROM execution_attempts WHERE external_source=? AND external_key=?')
        .get(attempt.externalSource, attempt.externalKey) as AttemptRow | undefined;
      if (replayRow) {
        const replay = rowToAttempt(replayRow);
        const taskRow = this.stmts.getById.get(replay.taskId) as TaskRow | undefined;
        if (!taskRow) throw new Error('execution attempt references a missing task');
        return { task: rowToTask(taskRow), attempt: replay, created: false };
      }
      this.insertTask(task);
      const persistedAttempt = { ...attempt, taskId: task.id };
      const inserted = this.db.prepare(`INSERT INTO execution_attempts
        (id,task_id,external_source,external_key,title_snapshot,description_snapshot,agent_type,related_task_id,auto_start,timeout_minutes,request_snapshot,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(persistedAttempt.id, persistedAttempt.taskId, persistedAttempt.externalSource, persistedAttempt.externalKey,
          persistedAttempt.titleSnapshot, persistedAttempt.descriptionSnapshot, persistedAttempt.agentType, persistedAttempt.relatedTaskId ?? null,
          persistedAttempt.autoStart ? 1 : 0, persistedAttempt.timeoutMinutes ?? null, persistedAttempt.requestSnapshot, persistedAttempt.status, persistedAttempt.createdAt);
      if (inserted.changes !== 1) throw new Error('failed to persist execution attempt');
      if (relatedTaskId) this.insertRelationship(task.id, relatedTaskId, relationshipCreatedAt);
      return { task, attempt: persistedAttempt, created: true };
    }).immediate();
  }

  async continueOrchestration(taskId: string, updates: Partial<Task>, attempt: ExecutionAttempt, relatedTaskId?: string, relationshipCreatedAt = Date.now(), eligibility?: ContinuationEligibility) {
    // Acquire the writer lock before reading eligibility so separate SQLite
    // connections cannot both decide from the same stale task snapshot.
    return this.db.transaction(() => {
      const taskRow = this.stmts.getById.get(taskId) as TaskRow | undefined;
      if (!taskRow) return undefined;
      const replayRow = this.db.prepare('SELECT * FROM execution_attempts WHERE external_source=? AND external_key=?')
        .get(attempt.externalSource, attempt.externalKey) as AttemptRow | undefined;
      if (replayRow) {
        const replay = rowToAttempt(replayRow);
        const replayTaskRow = this.stmts.getById.get(replay.taskId) as TaskRow | undefined;
        if (!replayTaskRow) throw new Error('execution attempt references a missing task');
        return { task: rowToTask(replayTaskRow), attempt: replay, created: false };
      }
      const current = rowToTask(taskRow);
      if (eligibility?.requiredAgentStatus && current.agentStatus !== eligibility.requiredAgentStatus) return undefined;
      if (eligibility?.requireRunnable
        && ((current.runRequestedAt !== undefined && (current.runClaimedAt === undefined || current.agentStatus === 'idle'))
          || current.agentStatus === 'planning' || current.agentStatus === 'executing')) return undefined;
      const persistedAttempt = { ...attempt, taskId };
      this.db.prepare(`INSERT INTO execution_attempts
        (id,task_id,external_source,external_key,title_snapshot,description_snapshot,agent_type,related_task_id,auto_start,timeout_minutes,request_snapshot,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(persistedAttempt.id, taskId, persistedAttempt.externalSource, persistedAttempt.externalKey,
          persistedAttempt.titleSnapshot, persistedAttempt.descriptionSnapshot, persistedAttempt.agentType, persistedAttempt.relatedTaskId ?? null,
          persistedAttempt.autoStart ? 1 : 0, persistedAttempt.timeoutMinutes ?? null, persistedAttempt.requestSnapshot, persistedAttempt.status, persistedAttempt.createdAt);
      if (relatedTaskId) this.insertRelationship(taskId, relatedTaskId, relationshipCreatedAt);
      this.updateExisting(current, updates);
      const updatedRow = this.stmts.getById.get(taskId) as TaskRow | undefined;
      if (!updatedRow) throw new Error('failed to reset orchestration task');
      return { task: rowToTask(updatedRow), attempt: persistedAttempt, created: true };
    }).immediate();
  }

  private insertRelationship(taskId: string, relatedTaskId: string, createdAt: number): void {
    if (taskId === relatedTaskId) throw new Error('a task cannot be related to itself');
    const [left, right] = taskId < relatedTaskId ? [taskId, relatedTaskId] : [relatedTaskId, taskId];
    this.db.prepare(`INSERT OR IGNORE INTO task_relationships (task_id, related_task_id, type, created_at)
      SELECT ?, ?, 'related', ? FROM tasks a JOIN tasks b ON b.id = ? WHERE a.id = ? AND a.project_id = b.project_id`).run(left, right, createdAt, right, left);
    const exists = this.db.prepare('SELECT 1 FROM task_relationships WHERE task_id=? AND related_task_id=?').get(left, right);
    if (!exists) throw new Error('tasks must exist in the same project');
  }
}
