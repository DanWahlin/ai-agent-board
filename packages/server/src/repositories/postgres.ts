import { Pool } from 'pg';
import type { Task, Priority, ColumnId, AgentStatus, AgentType, AgentEvent } from '../types.js';
import type { TaskRepository } from './types.js';
import { isValidPriority, isValidColumnId, isValidAgentStatus, isValidAgentType } from '@ai-agent-board/shared/constants.js';
import { errorMessage } from '../utils.js';

interface TaskRow {
  id: string;
  title: string;
  description: string;
  priority: string;
  column_id: string;
  agent_status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  repo_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  use_worktree: boolean | null;
  worktree_path: string | null;
  agent_type: string;
  archived: boolean;
  project_id: string;
  group_id: string | null;
  group_order: number | null;
  summary: string | null;
  external_source: string | null; external_key: string | null; provenance: string | null;
  run_requested_at: string | null; run_claimed_at: string | null;
  timeout_minutes: number | null;
}

function rowToTask(row: TaskRow): Task {
  // Validate and log warnings for invalid values
  if (!isValidPriority(row.priority)) {
    console.warn(`[postgres] Invalid priority in database: ${row.priority} for task ${row.id}, using 'medium' as default`);
    row.priority = 'medium';
  }

  if (!isValidColumnId(row.column_id)) {
    console.warn(`[postgres] Invalid column_id in database: ${row.column_id} for task ${row.id}, using 'backlog' as default`);
    row.column_id = 'backlog';
  }

  if (!isValidAgentStatus(row.agent_status)) {
    console.warn(`[postgres] Invalid agent_status in database: ${row.agent_status} for task ${row.id}, using 'idle' as default`);
    row.agent_status = 'idle';
  }

  if (!isValidAgentType(row.agent_type)) {
    console.warn(`[postgres] Invalid agent_type in database: ${row.agent_type} for task ${row.id}, using 'copilot' as default`);
    row.agent_type = 'copilot';
  }

  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    priority: row.priority as Priority,
    columnId: row.column_id as ColumnId,
    agentStatus: row.agent_status as AgentStatus,
    createdAt: Number(row.created_at),
    startedAt: row.started_at != null ? Number(row.started_at) : undefined,
    completedAt: row.completed_at != null ? Number(row.completed_at) : undefined,
    repoPath: row.repo_path ?? undefined,
    branchName: row.branch_name ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    useWorktree: row.use_worktree ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    agentType: row.agent_type as AgentType,
    archived: row.archived,
    groupId: row.group_id ?? undefined,
    groupOrder: row.group_order ?? undefined,
    summary: row.summary ?? null, externalSource: row.external_source ?? undefined, externalKey: row.external_key ?? undefined,
    provenance: row.provenance ? JSON.parse(row.provenance) : undefined,
    runRequestedAt: row.run_requested_at != null ? Number(row.run_requested_at) : undefined, runClaimedAt: row.run_claimed_at != null ? Number(row.run_claimed_at) : undefined,
    timeoutMinutes: row.timeout_minutes ?? undefined,
  };
}

export class PostgresTaskRepository implements TaskRepository {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async getAll(includeArchived = false, projectId = 'default'): Promise<Task[]> {
    const query = includeArchived
      ? 'SELECT * FROM tasks WHERE project_id = $1 AND group_id IS NULL ORDER BY created_at ASC'
      : 'SELECT * FROM tasks WHERE project_id = $1 AND archived = FALSE AND group_id IS NULL ORDER BY created_at ASC';
    const { rows } = await this.pool.query<TaskRow>(query, [projectId]);
    return rows.map(rowToTask);
  }

  async getById(id: string): Promise<Task | undefined> {
    const { rows } = await this.pool.query<TaskRow>(
      'SELECT * FROM tasks WHERE id = $1',
      [id]
    );
    return rows[0] ? rowToTask(rows[0]) : undefined;
  }

  async getByExternalIdentity(source: string, key: string): Promise<Task | undefined> {
    const { rows } = await this.pool.query<TaskRow>('SELECT * FROM tasks WHERE external_source=$1 AND external_key=$2', [source,key]); return rows[0] ? rowToTask(rows[0]) : undefined;
  }

  async create(task: Task): Promise<Task> {
    await this.pool.query(
      `INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type,
        created_at, started_at, completed_at, repo_path, branch_name, base_branch, use_worktree, worktree_path, archived,
        group_id, group_order, summary, external_source, external_key, provenance, run_requested_at, run_claimed_at, timeout_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
      [
        task.id,
        task.projectId,
        task.title,
        task.description,
        task.priority,
        task.columnId,
        task.agentStatus,
        task.agentType ?? 'copilot',
        task.createdAt,
        task.startedAt ?? null,
        task.completedAt ?? null,
        task.repoPath ?? null,
        task.branchName ?? null,
        task.baseBranch ?? null,
        task.useWorktree ?? null,
        task.worktreePath ?? null,
        task.archived ?? false,
        task.groupId ?? null,
        task.groupOrder ?? null,
        task.summary ?? null, task.externalSource ?? null, task.externalKey ?? null, task.provenance ? JSON.stringify(task.provenance) : null, task.runRequestedAt ?? null, task.runClaimedAt ?? null, task.timeoutMinutes ?? null,
      ]
    );
    return task;
  }

  async createIdempotent(task: Task): Promise<{ task: Task; created: boolean }> {
    try { await this.create(task); return {task,created:true}; } catch (err: any) {
      if (err?.code === '23505' && task.externalSource && task.externalKey) { const existing=await this.getByExternalIdentity(task.externalSource,task.externalKey); if(existing) return {task:existing,created:false}; } throw err;
    }
  }
  async requestRun(id:string,at:number) { const {rows}=await this.pool.query<TaskRow>('UPDATE tasks SET run_requested_at=$1,run_claimed_at=NULL WHERE id=$2 RETURNING *',[at,id]); return rows[0]?rowToTask(rows[0]):undefined; }
  async claimRun(id:string,at:number) { const staleBefore=at-30_000; const {rows}=await this.pool.query<TaskRow>("UPDATE tasks SET run_claimed_at=$1 WHERE id=$2 AND run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < $3) AND agent_status NOT IN ('complete','failed') RETURNING *",[at,id,staleBefore]); return rows[0]?rowToTask(rows[0]):undefined; }
  async clearRun(id:string) { const {rows}=await this.pool.query<TaskRow>('UPDATE tasks SET run_requested_at=NULL,run_claimed_at=NULL WHERE id=$1 RETURNING *',[id]); return rows[0]?rowToTask(rows[0]):undefined; }
  async getPendingRuns(staleBefore=Date.now()-30_000) { const {rows}=await this.pool.query<TaskRow>("SELECT * FROM tasks WHERE run_requested_at IS NOT NULL AND (run_claimed_at IS NULL OR run_claimed_at < $1) AND agent_status NOT IN ('complete','failed') ORDER BY run_requested_at",[staleBefore]); return rows.map(rowToTask); }

  async update(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<TaskRow>(
        'SELECT * FROM tasks WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const existing = rowToTask(rows[0]);
      const merged = { ...existing, ...updates };
      await client.query(
        `UPDATE tasks SET
          title = $1, description = $2, priority = $3, column_id = $4,
          agent_status = $5, agent_type = $6, started_at = $7, completed_at = $8,
          repo_path = $9, branch_name = $10, base_branch = $11, use_worktree = $12,
          worktree_path = $13, archived = $14, summary = $15, run_requested_at=$16, run_claimed_at=$17,
          timeout_minutes=$18
        WHERE id = $19`,
        [
          merged.title,
          merged.description,
          merged.priority,
          merged.columnId,
          merged.agentStatus,
          merged.agentType,
          merged.startedAt ?? null,
          merged.completedAt ?? null,
          merged.repoPath ?? null,
          merged.branchName ?? null,
          merged.baseBranch ?? null,
          merged.useWorktree ?? null,
          merged.worktreePath ?? null,
          merged.archived ?? false,
          merged.summary ?? null, merged.runRequestedAt ?? null, merged.runClaimedAt ?? null, merged.timeoutMinutes ?? null,
          id,
        ]
      );
      await client.query('COMMIT');
      return merged;
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ cnt: string }>(
      'SELECT COUNT(*) as cnt FROM tasks'
    );
    return Number(rows[0].cnt);
  }

  async insertEvent(event: AgentEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO events (id, task_id, type, content, timestamp, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.id,
        event.taskId,
        event.type,
        event.content,
        event.timestamp,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ]
    );
  }

  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    const { rows } = await this.pool.query<{
      id: string;
      task_id: string;
      type: string;
      content: string;
      timestamp: string;
      metadata: string | null;
    }>(
      'SELECT * FROM events WHERE task_id = $1 ORDER BY timestamp ASC',
      [taskId]
    );
    return rows.map((row) => {
      let metadata: AgentEvent['metadata'] | undefined;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata);
        } catch (err: unknown) {
          // Log malformed metadata
          console.warn(`[postgres] Failed to parse metadata for event ${row.id}:`, errorMessage(err));
        }
      }
      return {
        id: row.id,
        taskId: row.task_id,
        type: row.type as AgentEvent['type'],
        content: row.content,
        timestamp: Number(row.timestamp),
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  async deleteEventsByTaskId(taskId: string): Promise<void> {
    await this.pool.query('DELETE FROM events WHERE task_id = $1', [taskId]);
  }

  async getArchivedTasks(projectId = 'default'): Promise<Task[]> {
    const { rows } = await this.pool.query<TaskRow>(
      'SELECT * FROM tasks WHERE project_id = $1 AND archived = TRUE ORDER BY created_at DESC',
      [projectId],
    );
    return rows.map(rowToTask);
  }
}
