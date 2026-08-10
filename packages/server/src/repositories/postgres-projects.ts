import { Pool } from 'pg';
import type { AgentType, ColumnId, Priority, Project, ProjectTaskCounts } from '../types.js';
import type { ProjectRepository } from './project-types.js';

interface ProjectRow {
  id: string;
  name: string;
  repo_path: string | null;
  repo_url: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  default_agent_type: string | null;
  default_priority: string | null;
  default_base_branch: string | null;
  default_use_worktree: boolean | null;
  aliases: string;
}

interface CountRow {
  column_id: ColumnId;
  count: string;
}

function emptyCounts(): ProjectTaskCounts {
  return { backlog: 0, 'in-progress': 0, review: 0, done: 0, total: 0 };
}

function rowToProject(row: ProjectRow, taskCounts?: ProjectTaskCounts): Project {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path ?? undefined,
    repoUrl: row.repo_url ?? undefined,
    isDefault: row.is_default,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    defaultAgentType: (row.default_agent_type ?? undefined) as AgentType | undefined,
    defaultPriority: (row.default_priority ?? undefined) as Priority | undefined,
    defaultBaseBranch: row.default_base_branch ?? undefined,
    defaultUseWorktree: row.default_use_worktree === null ? undefined : row.default_use_worktree,
    aliases: JSON.parse(row.aliases || '[]'),
    ...(taskCounts ? { taskCounts } : {}),
  };
}

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly pool: Pool) {}

  async getAllWithCounts(): Promise<Project[]> {
    const { rows } = await this.pool.query<ProjectRow>(`SELECT * FROM projects ORDER BY CASE WHEN id = 'default' THEN 0 ELSE 1 END, created_at ASC`);
    return Promise.all(rows.map(async (row) => rowToProject(row, await this.getCounts(row.id))));
  }

  async getById(id: string): Promise<Project | undefined> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]);
    return rows[0] ? rowToProject(rows[0], await this.getCounts(rows[0].id)) : undefined;
  }

  async getDefault(): Promise<Project | undefined> {
    return this.getById('default');
  }

  async resolve(reference: string): Promise<Project[]> {
    const needle = reference.trim().toLowerCase();
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects');
    const exactId = rows.find((row) => row.id.toLowerCase() === needle);
    if (exactId) return [rowToProject(exactId, await this.getCounts(exactId.id))];
    const matches = rows.filter((row) => {
      const aliases = JSON.parse(row.aliases || '[]') as string[];
      return row.name.toLowerCase() === needle
        || aliases.some((alias) => alias.toLowerCase() === needle)
        || row.repo_path?.toLowerCase() === needle
        || row.repo_url?.replace(/\.git$/i, '').toLowerCase() === needle.replace(/\.git$/i, '');
    });
    return Promise.all(matches.map(async (row) => rowToProject(row, await this.getCounts(row.id))));
  }

  async create(input: {
    id: string;
    name: string;
    repoPath?: string;
    repoUrl?: string;
    defaultAgentType?: AgentType;
    defaultPriority?: Priority;
    defaultBaseBranch?: string;
    defaultUseWorktree?: boolean;
    aliases?: string[];
    createdAt: number;
    updatedAt: number;
  }): Promise<Project> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ProjectRow>(
        `INSERT INTO projects (id, name, repo_path, repo_url, is_default, created_at, updated_at,
           default_agent_type, default_priority, default_base_branch, default_use_worktree, aliases)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          input.id,
          input.name,
          input.repoPath ?? null,
          input.repoUrl ?? null,
          false,
          input.createdAt,
          input.updatedAt,
          input.defaultAgentType ?? null,
          input.defaultPriority ?? null,
          input.defaultBaseBranch ?? null,
          input.defaultUseWorktree ?? null, JSON.stringify(input.aliases ?? []),
        ],
      );
      await client.query('COMMIT');
      return rowToProject(rows[0], await this.getCounts(input.id));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async update(id: string, updates: {
    name?: string;
    repoPath?: string | null;
    repoUrl?: string | null;
    defaultAgentType?: AgentType | null;
    defaultPriority?: Priority | null;
    defaultBaseBranch?: string | null;
    defaultUseWorktree?: boolean | null;
    aliases?: string[];
    updatedAt: number;
  }): Promise<Project | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ProjectRow>('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const existing = rows[0];
      const { rows: updatedRows } = await client.query<ProjectRow>(
        `UPDATE projects
         SET name = $1, repo_path = $2, repo_url = $3, is_default = $4, updated_at = $5,
           default_agent_type = $6, default_priority = $7, default_base_branch = $8, default_use_worktree = $9, aliases=$10
         WHERE id = $11
         RETURNING *`,
        [
          updates.name ?? existing.name,
          updates.repoPath === undefined ? existing.repo_path : updates.repoPath,
          updates.repoUrl === undefined ? existing.repo_url : updates.repoUrl,
          existing.is_default,
          updates.updatedAt,
          updates.defaultAgentType === undefined ? existing.default_agent_type : updates.defaultAgentType,
          updates.defaultPriority === undefined ? existing.default_priority : updates.defaultPriority,
          updates.defaultBaseBranch === undefined ? existing.default_base_branch : updates.defaultBaseBranch,
          updates.defaultUseWorktree === undefined ? existing.default_use_worktree : updates.defaultUseWorktree, updates.aliases === undefined ? existing.aliases : JSON.stringify(updates.aliases),
          id,
        ],
      );
      await client.query('COMMIT');
      return rowToProject(updatedRows[0], await this.getCounts(id));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async hasTasksOrGroups(id: string): Promise<boolean> {
    const [{ count: taskCount }] = (await this.pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM tasks WHERE project_id = $1', [id])).rows;
    if (Number(taskCount) > 0) return true;
    const [{ count: groupCount }] = (await this.pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM task_groups WHERE project_id = $1', [id])).rows;
    return Number(groupCount) > 0;
  }

  async delete(id: string): Promise<boolean> {
    if (id === 'default') return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ProjectRow>('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }
      // Cascade: delete tasks (their events cascade via FK, and group children share
      // project_id so they are removed too), then groups, then the project itself.
      await client.query('DELETE FROM tasks WHERE project_id = $1', [id]);
      await client.query('DELETE FROM task_groups WHERE project_id = $1', [id]);
      const result = await client.query('DELETE FROM projects WHERE id = $1', [id]);
      if (rows[0].is_default) {
        await client.query('UPDATE projects SET is_default = TRUE WHERE id = $1', ['default']);
      }
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async getCounts(projectId: string): Promise<ProjectTaskCounts> {
    const counts = emptyCounts();
    const taskRows = (await this.pool.query<CountRow>(
      `SELECT column_id, COUNT(*) AS count
       FROM tasks
       WHERE project_id = $1 AND archived = FALSE AND group_id IS NULL
       GROUP BY column_id`,
      [projectId],
    )).rows;
    const groupRows = (await this.pool.query<CountRow>(
      `SELECT column_id, COUNT(*) AS count
       FROM task_groups
       WHERE project_id = $1 AND archived = FALSE
       GROUP BY column_id`,
      [projectId],
    )).rows;
    for (const row of [...taskRows, ...groupRows]) {
      const count = Number(row.count);
      counts[row.column_id] += count;
      counts.total += count;
    }
    return counts;
  }
}
