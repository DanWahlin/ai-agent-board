import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { Pool } from 'pg';
import { SqliteProjectRepository } from '../src/repositories/sqlite-projects.js';
import { PostgresProjectRepository } from '../src/repositories/postgres-projects.js';

const rows = [
  {
    id: 'Project-Exact-ID', name: 'AgentMic', repo_path: '/root/projects/agent-mic',
    repo_url: 'https://example.test/agent-mic.git', is_default: false, created_at: '1', updated_at: '1',
    default_agent_type: null, default_priority: null, default_base_branch: null,
    default_use_worktree: null, aliases: JSON.stringify(['voice']),
  },
  {
    id: 'other-id', name: 'project-exact-id', repo_path: '/other', repo_url: null,
    is_default: false, created_at: '2', updated_at: '2', default_agent_type: null,
    default_priority: null, default_base_branch: null, default_use_worktree: null, aliases: '[]',
  },
  {
    id: 'duplicate-one', name: 'Shared Project', repo_path: '/duplicate-one', repo_url: null,
    is_default: false, created_at: '3', updated_at: '3', default_agent_type: null,
    default_priority: null, default_base_branch: null, default_use_worktree: null,
    aliases: JSON.stringify(['shared-alias']),
  },
  {
    id: 'duplicate-two', name: 'shared project', repo_path: '/duplicate-two', repo_url: null,
    is_default: false, created_at: '4', updated_at: '4', default_agent_type: null,
    default_priority: null, default_base_branch: null, default_use_worktree: null,
    aliases: JSON.stringify(['SHARED-ALIAS']),
  },
];

function sqliteRepository(): { repository: SqliteProjectRepository; close(): void } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT, repo_url TEXT,
      is_default INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      default_agent_type TEXT, default_priority TEXT, default_base_branch TEXT,
      default_use_worktree INTEGER, aliases TEXT NOT NULL);
    CREATE TABLE tasks (project_id TEXT, column_id TEXT, archived INTEGER, group_id TEXT);
    CREATE TABLE task_groups (project_id TEXT, column_id TEXT, archived INTEGER);
  `);
  const insert = db.prepare(`INSERT INTO projects VALUES
    (@id,@name,@repo_path,@repo_url,@is_default,@created_at,@updated_at,@default_agent_type,
     @default_priority,@default_base_branch,@default_use_worktree,@aliases)`);
  for (const row of rows) insert.run({ ...row, is_default: 0 });
  return { repository: new SqliteProjectRepository(db), close: () => db.close() };
}

function postgresRepository(): PostgresProjectRepository {
  const pool = {
    query: async (sql: string) => {
      if (sql === 'SELECT * FROM projects') return { rows };
      if (sql.includes('COUNT(*)')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  return new PostgresProjectRepository(pool);
}

async function assertResolutionContract(repository: { resolve(reference: string): Promise<Array<{ id: string }>> }) {
  assert.deepEqual((await repository.resolve('Project-Exact-ID')).map(({ id }) => id), ['Project-Exact-ID']);
  assert.deepEqual((await repository.resolve('project-exact-id')).map(({ id }) => id), ['other-id']);
  assert.deepEqual((await repository.resolve('AgentMic')).map(({ id }) => id), ['Project-Exact-ID']);
  assert.deepEqual((await repository.resolve('VOICE')).map(({ id }) => id), ['Project-Exact-ID']);
  assert.deepEqual((await repository.resolve('Shared Project')).map(({ id }) => id), ['duplicate-one', 'duplicate-two']);
  assert.deepEqual((await repository.resolve('shared-alias')).map(({ id }) => id), ['duplicate-one', 'duplicate-two']);
  assert.deepEqual(await repository.resolve('/root/projects/agent-mic'), []);
  assert.deepEqual(await repository.resolve('https://example.test/agent-mic.git'), []);
}

test('SQLite resolves only exact ids, names, and aliases', async () => {
  const { repository, close } = sqliteRepository();
  try { await assertResolutionContract(repository); } finally { close(); }
});

test('PostgreSQL resolves only exact ids, names, and aliases', async () => {
  await assertResolutionContract(postgresRepository());
});