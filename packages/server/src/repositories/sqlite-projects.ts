import Database from 'better-sqlite3';
import type { AgentType, ColumnId, Priority, Project, ProjectTaskCounts } from '../types.js';
import type { ProjectRepository } from './project-types.js';

interface ProjectRow {
  id: string;
  name: string;
  repo_path: string | null;
  repo_url: string | null;
  is_default: number;
  created_at: number;
  updated_at: number;
  default_agent_type: string | null;
  default_priority: string | null;
  default_base_branch: string | null;
  default_use_worktree: number | null;
  aliases: string;
}

interface CountRow {
  column_id: ColumnId;
  count: number;
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
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    defaultAgentType: (row.default_agent_type ?? undefined) as AgentType | undefined,
    defaultPriority: (row.default_priority ?? undefined) as Priority | undefined,
    defaultBaseBranch: row.default_base_branch ?? undefined,
    defaultUseWorktree: row.default_use_worktree === null ? undefined : Boolean(row.default_use_worktree),
    aliases: JSON.parse(row.aliases || '[]'),
    ...(taskCounts ? { taskCounts } : {}),
  };
}

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  async getAllWithCounts(): Promise<Project[]> {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY CASE WHEN id = 'default' THEN 0 ELSE 1 END, created_at ASC`).all() as ProjectRow[];
    return rows.map((row) => rowToProject(row, this.getCounts(row.id)));
  }

  async getById(id: string): Promise<Project | undefined> {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? rowToProject(row, this.getCounts(row.id)) : undefined;
  }

  async getDefault(): Promise<Project | undefined> {
    return this.getById('default');
  }

  async resolve(reference: string): Promise<Project[]> {
    const needle = reference.trim().toLowerCase();
    const rows = this.db.prepare('SELECT * FROM projects').all() as ProjectRow[];
    const exactId = rows.find((row) => row.id.toLowerCase() === needle);
    if (exactId) return [rowToProject(exactId, this.getCounts(exactId.id))];
    return rows.filter((row) => {
      const aliases = JSON.parse(row.aliases || '[]') as string[];
      return row.name.toLowerCase() === needle
        || aliases.some((alias) => alias.toLowerCase() === needle)
        || row.repo_path?.toLowerCase() === needle
        || row.repo_url?.replace(/\.git$/i, '').toLowerCase() === needle.replace(/\.git$/i, '');
    }).map((row) => rowToProject(row, this.getCounts(row.id)));
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
    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO projects (id, name, repo_path, repo_url, is_default, created_at, updated_at,
          default_agent_type, default_priority, default_base_branch, default_use_worktree, aliases)
        VALUES (@id, @name, @repo_path, @repo_url, @is_default, @created_at, @updated_at,
          @default_agent_type, @default_priority, @default_base_branch, @default_use_worktree, @aliases)
      `).run({
        id: input.id,
        name: input.name,
        repo_path: input.repoPath ?? null,
        repo_url: input.repoUrl ?? null,
        is_default: 0,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
        default_agent_type: input.defaultAgentType ?? null,
        default_priority: input.defaultPriority ?? null,
        default_base_branch: input.defaultBaseBranch ?? null,
        default_use_worktree: input.defaultUseWorktree === undefined ? null : input.defaultUseWorktree ? 1 : 0, aliases: JSON.stringify(input.aliases ?? []),
      });
      const created = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(input.id) as ProjectRow;
      return rowToProject(created, this.getCounts(input.id));
    })();
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
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
      if (!row) return undefined;
      const merged = {
        id,
        name: updates.name ?? row.name,
        repo_path: updates.repoPath === undefined ? row.repo_path : updates.repoPath,
        repo_url: updates.repoUrl === undefined ? row.repo_url : updates.repoUrl,
        is_default: row.is_default,
        updated_at: updates.updatedAt,
        default_agent_type: updates.defaultAgentType === undefined ? row.default_agent_type : updates.defaultAgentType,
        default_priority: updates.defaultPriority === undefined ? row.default_priority : updates.defaultPriority,
        default_base_branch: updates.defaultBaseBranch === undefined ? row.default_base_branch : updates.defaultBaseBranch,
        default_use_worktree: updates.defaultUseWorktree === undefined
          ? row.default_use_worktree
          : updates.defaultUseWorktree === null ? null : updates.defaultUseWorktree ? 1 : 0, aliases: updates.aliases === undefined ? row.aliases : JSON.stringify(updates.aliases),
      };
      this.db.prepare(`
        UPDATE projects
        SET name = @name, repo_path = @repo_path, repo_url = @repo_url, is_default = @is_default, updated_at = @updated_at,
          default_agent_type = @default_agent_type, default_priority = @default_priority,
          default_base_branch = @default_base_branch, default_use_worktree = @default_use_worktree, aliases = @aliases
        WHERE id = @id
      `).run(merged);
      const updated = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
      return rowToProject(updated, this.getCounts(id));
    })();
  }

  async hasTasksOrGroups(id: string): Promise<boolean> {
    const taskCount = (this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?').get(id) as { count: number }).count;
    if (taskCount > 0) return true;
    const groupCount = (this.db.prepare('SELECT COUNT(*) AS count FROM task_groups WHERE project_id = ?').get(id) as { count: number }).count;
    return groupCount > 0;
  }

  async delete(id: string): Promise<boolean> {
    if (id === 'default') return false;
    return this.db.transaction(() => {
      const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
      if (!project) return false;
      // Cascade: delete tasks (their events cascade via FK, and group children share
      // project_id so they are removed too), then groups, then the project itself.
      this.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM task_groups WHERE project_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      if (project.is_default) {
        this.db.prepare('UPDATE projects SET is_default = 1 WHERE id = ?').run('default');
      }
      return result.changes > 0;
    })();
  }

  private getCounts(projectId: string): ProjectTaskCounts {
    const counts = emptyCounts();
    const taskRows = this.db.prepare(`
      SELECT column_id, COUNT(*) AS count
      FROM tasks
      WHERE project_id = ? AND archived = 0 AND group_id IS NULL
      GROUP BY column_id
    `).all(projectId) as CountRow[];
    const groupRows = this.db.prepare(`
      SELECT column_id, COUNT(*) AS count
      FROM task_groups
      WHERE project_id = ? AND archived = 0
      GROUP BY column_id
    `).all(projectId) as CountRow[];
    for (const row of [...taskRows, ...groupRows]) {
      counts[row.column_id] += row.count;
      counts.total += row.count;
    }
    return counts;
  }
}
