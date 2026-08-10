import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { TaskGroup, Task, Priority, ColumnId, AgentType, AgentStatus } from '../types.js';
import type { TaskGroupRepository } from './group-types.js';

interface GroupRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: Priority;
  column_id: ColumnId;
  repo_path: string | null;
  base_branch: string | null;
  max_concurrency: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  archived: number;
}

interface TaskRow {
  id: string;
  project_id: string;
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
    priority: row.priority,
    columnId: row.column_id,
    repoPath: row.repo_path ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    maxConcurrency: row.max_concurrency,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    archived: Boolean(row.archived),
  };
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
    timeoutMinutes: row.timeout_minutes ?? undefined,
  };
}

export class SqliteTaskGroupRepository implements TaskGroupRepository {
  private db: Database.Database;
  private stmts: {
    getAll: Database.Statement;
    getAllIncludingArchived: Database.Statement;
    getById: Database.Statement;
    insertGroup: Database.Statement;
    insertChild: Database.Statement;
    update: Database.Statement;
    delete: Database.Statement;
    getChildren: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.stmts = {
      getAll: db.prepare('SELECT * FROM task_groups WHERE project_id = ? AND archived = 0 ORDER BY created_at ASC'),
      getAllIncludingArchived: db.prepare('SELECT * FROM task_groups WHERE project_id = ? ORDER BY created_at ASC'),
      getById: db.prepare('SELECT * FROM task_groups WHERE id = ?'),
      insertGroup: db.prepare(`
        INSERT INTO task_groups (id, project_id, title, description, priority, column_id, repo_path, base_branch,
          max_concurrency, created_at, started_at, completed_at, archived)
        VALUES (@id, @project_id, @title, @description, @priority, @column_id, @repo_path, @base_branch,
          @max_concurrency, @created_at, @started_at, @completed_at, @archived)
      `),
      insertChild: db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, priority, column_id, agent_status, agent_type,
          created_at, repo_path, base_branch, use_worktree, branch_name, archived, group_id, group_order,
          started_at, completed_at, worktree_path)
        VALUES (@id, @project_id, @title, @description, @priority, @column_id, @agent_status, @agent_type,
          @created_at, @repo_path, @base_branch, @use_worktree, @branch_name, 0, @group_id, @group_order,
          NULL, NULL, NULL)
      `),
      update: db.prepare(`
        UPDATE task_groups SET
          title = @title, description = @description, priority = @priority,
          column_id = @column_id, repo_path = @repo_path, base_branch = @base_branch,
          max_concurrency = @max_concurrency, started_at = @started_at,
          completed_at = @completed_at, archived = @archived
        WHERE id = @id
      `),
      delete: db.prepare('DELETE FROM task_groups WHERE id = ?'),
      getChildren: db.prepare('SELECT * FROM tasks WHERE group_id = ? ORDER BY group_order ASC'),
    };
  }

  async getAll(includeArchived = false, projectId = 'default'): Promise<TaskGroup[]> {
    const stmt = includeArchived ? this.stmts.getAllIncludingArchived : this.stmts.getAll;
    return (stmt.all(projectId) as GroupRow[]).map(rowToGroup);
  }

  async getById(id: string): Promise<TaskGroup | undefined> {
    const row = this.stmts.getById.get(id) as GroupRow | undefined;
    return row ? rowToGroup(row) : undefined;
  }

  async create(
    group: TaskGroup,
    children: Omit<Task, 'columnId' | 'agentStatus' | 'createdAt'>[],
  ): Promise<{ group: TaskGroup; children: Task[] }> {
    return this.db.transaction(() => {
      this.stmts.insertGroup.run({
        id: group.id,
        project_id: group.projectId,
        title: group.title,
        description: group.description ?? '',
        priority: group.priority,
        column_id: group.columnId,
        repo_path: group.repoPath ?? null,
        base_branch: group.baseBranch ?? null,
        max_concurrency: group.maxConcurrency,
        created_at: group.createdAt,
        started_at: group.startedAt ?? null,
        completed_at: group.completedAt ?? null,
        archived: group.archived ? 1 : 0,
      });

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

        this.stmts.insertChild.run({
          id: task.id,
          project_id: task.projectId,
          title: task.title,
          description: task.description,
          priority: task.priority,
          column_id: task.columnId,
          agent_status: task.agentStatus,
          agent_type: task.agentType ?? 'copilot',
          created_at: task.createdAt,
          repo_path: task.repoPath ?? null,
          base_branch: task.baseBranch ?? null,
          use_worktree: task.useWorktree != null ? (task.useWorktree ? 1 : 0) : null,
          branch_name: task.branchName ?? null,
          group_id: group.id,
          group_order: task.groupOrder ?? i,
        });

        createdChildren.push(task);
      }

      return { group, children: createdChildren };
    })();
  }

  async update(id: string, updates: Partial<Omit<TaskGroup, 'id' | 'createdAt'>>): Promise<TaskGroup | undefined> {
    return this.db.transaction(() => {
      const row = this.stmts.getById.get(id) as GroupRow | undefined;
      if (!row) return undefined;
      const existing = rowToGroup(row);
      const merged = { ...existing, ...updates };
      this.stmts.update.run({
        id,
        title: merged.title,
        description: merged.description ?? '',
        priority: merged.priority,
        column_id: merged.columnId,
        repo_path: merged.repoPath ?? null,
        base_branch: merged.baseBranch ?? null,
        max_concurrency: merged.maxConcurrency,
        started_at: merged.startedAt ?? null,
        completed_at: merged.completedAt ?? null,
        archived: merged.archived ? 1 : 0,
      });
      return merged;
    })();
  }

  async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id);
    return result.changes > 0;
  }

  async getChildTasks(groupId: string): Promise<Task[]> {
    return (this.stmts.getChildren.all(groupId) as TaskRow[]).map(rowToTask);
  }
}
