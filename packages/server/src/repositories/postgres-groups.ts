import { Pool } from 'pg';
import { v4 as uuid } from 'uuid';
import type { TaskGroup, Task, Priority, ColumnId, AgentType, AgentStatus } from '../types.js';
import type { TaskGroupRepository } from './group-types.js';

interface GroupRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: string;
  column_id: string;
  repo_path: string | null;
  base_branch: string | null;
  max_concurrency: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  archived: boolean;
}

interface TaskRow {
  id: string;
  project_id: string;
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
  group_id: string | null;
  group_order: number | null;
  timeout_minutes: number | null;
}

function rowToGroup(row: GroupRow): TaskGroup {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description || undefined,
    priority: row.priority as Priority,
    columnId: row.column_id as ColumnId,
    repoPath: row.repo_path ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    maxConcurrency: row.max_concurrency,
    createdAt: Number(row.created_at),
    startedAt: row.started_at != null ? Number(row.started_at) : undefined,
    completedAt: row.completed_at != null ? Number(row.completed_at) : undefined,
    archived: row.archived,
  };
}

function rowToTask(row: TaskRow): Task {
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
    timeoutMinutes: row.timeout_minutes ?? undefined,
  };
}

export class PostgresTaskGroupRepository implements TaskGroupRepository {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async getAll(includeArchived = false, projectId = 'default'): Promise<TaskGroup[]> {
    const query = includeArchived
      ? 'SELECT * FROM task_groups WHERE project_id = $1 ORDER BY created_at ASC'
      : 'SELECT * FROM task_groups WHERE project_id = $1 AND archived = FALSE ORDER BY created_at ASC';
    const { rows } = await this.pool.query<GroupRow>(query, [projectId]);
    return rows.map(rowToGroup);
  }

  async getById(id: string): Promise<TaskGroup | undefined> {
    const { rows } = await this.pool.query<GroupRow>('SELECT * FROM task_groups WHERE id = $1', [id]);
    return rows[0] ? rowToGroup(rows[0]) : undefined;
  }

  async create(
    group: TaskGroup,
    children: Omit<Task, 'columnId' | 'agentStatus' | 'createdAt'>[],
  ): Promise<{ group: TaskGroup; children: Task[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO task_groups (id, project_id, title, description, priority, column_id, repo_path, base_branch,
          max_concurrency, created_at, started_at, completed_at, archived)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [group.id, group.projectId, group.title, group.description ?? '', group.priority, group.columnId,
         group.repoPath ?? null, group.baseBranch ?? null, group.maxConcurrency,
         group.createdAt, group.startedAt ?? null, group.completedAt ?? null, group.archived ?? false],
      );

      const createdChildren: Task[] = [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const taskId = child.id || uuid();
        const task: Task = {
          id: taskId,
          projectId: group.projectId,
          title: child.title,
          description: child.description,
          priority: child.priority ?? group.priority,
          columnId: group.columnId,
          agentStatus: 'idle',
          createdAt: group.createdAt,
          repoPath: group.repoPath,
          baseBranch: group.baseBranch,
          useWorktree: child.useWorktree,
          agentType: child.agentType,
          branchName: child.branchName,
          groupId: group.id,
          groupOrder: child.groupOrder ?? i,
        };

        await client.query(
          `INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type,
            created_at, repo_path, base_branch, use_worktree, branch_name, archived, group_id, group_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [task.id, task.projectId, task.title, task.description, task.priority, task.columnId, task.agentStatus,
           task.agentType ?? 'copilot', task.createdAt, task.repoPath ?? null,
           task.baseBranch ?? null, task.useWorktree ?? null, task.branchName ?? null,
           false, group.id, task.groupOrder ?? i],
        );

        createdChildren.push(task);
      }

      await client.query('COMMIT');
      return { group, children: createdChildren };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async update(id: string, updates: Partial<Omit<TaskGroup, 'id' | 'createdAt'>>): Promise<TaskGroup | undefined> {
    const existing = await this.getById(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...updates };
    await this.pool.query(
      `UPDATE task_groups SET title=$1, description=$2, priority=$3, column_id=$4,
        repo_path=$5, base_branch=$6, max_concurrency=$7, started_at=$8,
        completed_at=$9, archived=$10
       WHERE id=$11`,
      [merged.title, merged.description ?? '', merged.priority, merged.columnId,
       merged.repoPath ?? null, merged.baseBranch ?? null, merged.maxConcurrency,
       merged.startedAt ?? null, merged.completedAt ?? null, merged.archived ?? false, id],
    );
    return merged;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM task_groups WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async getChildTasks(groupId: string): Promise<Task[]> {
    const { rows } = await this.pool.query<TaskRow>(
      'SELECT * FROM tasks WHERE group_id = $1 ORDER BY group_order ASC', [groupId],
    );
    return rows.map(rowToTask);
  }
}
