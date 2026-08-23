import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { PostgresTaskRepository } from '../src/repositories/postgres.js';
import { createTaskRouter } from '../src/routes/tasks.js';
import { createOrchestrationsRouter } from '../src/routes/orchestrations.js';
import type { Task, Project } from '../src/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      priority TEXT, column_id TEXT, agent_status TEXT, agent_type TEXT, created_at INTEGER, started_at INTEGER,
      completed_at INTEGER, repo_path TEXT, branch_name TEXT, base_branch TEXT, use_worktree INTEGER,
      worktree_path TEXT, archived INTEGER, group_id TEXT, group_order INTEGER, summary TEXT, external_source TEXT,
      external_key TEXT, provenance TEXT, run_requested_at INTEGER, run_claimed_at INTEGER, timeout_minutes INTEGER);
    CREATE UNIQUE INDEX identity ON tasks(external_source,external_key) WHERE external_source IS NOT NULL AND external_key IS NOT NULL;
    CREATE TABLE events(id TEXT,task_id TEXT,type TEXT,content TEXT,timestamp INTEGER,metadata TEXT);
    CREATE TABLE task_relationships(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      related_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL DEFAULT 'related',
      created_at INTEGER NOT NULL, PRIMARY KEY(task_id,related_task_id), CHECK(task_id < related_task_id));
    CREATE TABLE execution_attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      external_source TEXT NOT NULL, external_key TEXT NOT NULL, title_snapshot TEXT NOT NULL, description_snapshot TEXT NOT NULL,
      agent_type TEXT NOT NULL, related_task_id TEXT, auto_start INTEGER NOT NULL, timeout_minutes INTEGER,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(external_source, external_key));
  `);
  return db;
}

const task = (id: string, projectId = 'project-a', title = id): Task => ({
  id, projectId, title, description: '', priority: 'medium', columnId: 'backlog', agentStatus: 'idle',
  agentType: 'hermes', createdAt: Number(id.replace(/\D/g, '')) || 1, repoPath: '/repo', baseBranch: 'main',
  branchName: `agent/${id}`, useWorktree: true,
});

const project: Project = { id: 'project-a', name: 'Project A', aliases: ['alpha'], repoPath: '/repo', isDefault: false, createdAt: 1, updatedAt: 1 };
const projects = {
  getById: async (id: string) => id === project.id ? project : undefined,
  resolve: async (ref: string) => ['project-a', 'Project A', 'alpha'].some((v) => v.toLowerCase() === ref.trim().toLowerCase()) ? [project] : [],
} as ProjectRepository;
const agents = {
  getAvailableAgents: () => [{ name: 'hermes', displayName: 'Hermes', available: true }],
  isRunning: () => false,
  stopAgent: () => undefined,
  clearEvents: () => undefined,
  sendMessage: async () => false,
} as unknown as AgentManager;

async function withApi(repo: SqliteTaskRepository, run: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createTaskRouter(repo, agents, projects));
  app.use('/api/orchestrations', createOrchestrationsRouter(repo, projects, agents));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
}

test('SQLite relationships are symmetric, idempotent, same-project, and cascade', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('task-2'));
    await repo.create(task('task-1'));
    await repo.create(task('task-3', 'project-b'));
    const first = await repo.createRelationship('task-2', 'task-1', 123);
    assert.equal(first.created, true);
    assert.deepEqual(await repo.getRelationships('task-1'), [{ taskId: 'task-1', relatedTaskId: 'task-2', type: 'related', createdAt: 123 }]);
    assert.equal((await repo.createRelationship('task-1', 'task-2', 999)).created, false);
    await assert.rejects(repo.createRelationship('task-1', 'task-3', 1), /same project/);
    await repo.delete('task-2');
    assert.deepEqual(await repo.getRelationships('task-1'), []);
  } finally { db.close(); }
});

test('exact task resolution gives ids precedence and exposes title ambiguity', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('one', 'project-a', 'Duplicate'));
    await repo.create(task('two', 'project-a', 'duplicate'));
    await repo.create(task('Duplicate', 'project-a', 'Different'));
    assert.deepEqual((await repo.resolve('Duplicate', 'project-a')).map((item) => item.id), ['Duplicate']);
    assert.deepEqual((await repo.resolve('duplicate', 'project-a')).map((item) => item.id), ['one', 'two']);
    assert.deepEqual(await repo.resolve('one', 'project-b'), []);
  } finally { db.close(); }
});

test('relationship API fails closed on ambiguity and replays idempotently', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('root'));
    await repo.create(task('one', 'project-a', 'Same'));
    await repo.create(task('two', 'project-a', 'Same'));
    await withApi(repo, async (base) => {
      let response = await fetch(`${base}/api/tasks/root/relationships`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relatedTask: 'Same' }) });
      assert.equal(response.status, 409);
      response = await fetch(`${base}/api/tasks/root/relationships`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relatedTask: 'one' }) });
      assert.equal(response.status, 201);
      response = await fetch(`${base}/api/tasks/root/relationships`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relatedTask: 'one' }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('idempotent-replay'), 'true');
    });
  } finally { db.close(); }
});

test('orchestration persists distinct attempts, replays continuations, and tracks ordinary cards', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('existing', 'project-a', 'Existing work'));
    await repo.create(task('other', 'project-a', 'Other work'));
    await withApi(repo, async (base) => {
      let response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'new-work-1' }, body: JSON.stringify({ project: 'alpha', agent: 'hermes', title: 'New work', relatedItem: 'existing', autoStart: false }) });
      assert.equal(response.status, 201);
      const created = await response.json() as { task: Task; attempt: { id: string } };
      assert.ok(created.attempt.id);
      assert.deepEqual((await repo.getRelationships(created.task.id)).map((relation) => relation.relatedTaskId), ['existing']);

      response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'continue-1' }, body: JSON.stringify({ project: 'project-a', task: 'Existing work', description: 'Continue this work', autoStart: false }) });
      assert.equal(response.status, 202);
      const continued = await response.json() as { task: Task; attempt: { id: string }; continuation: boolean };
      assert.equal(continued.continuation, true);
      assert.equal(continued.task.id, 'existing');
      assert.notEqual(continued.attempt.id, created.attempt.id);
      assert.equal((await repo.getAttemptsByTaskId('existing')).length, 1);

      response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'continue-1' }, body: JSON.stringify({ project: 'project-a', task: 'Existing work', description: 'Continue this work', autoStart: false }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('idempotent-replay'), 'true');
      assert.equal(((await response.json()) as { attempt: { id: string } }).attempt.id, continued.attempt.id);
      assert.equal((await repo.getAttemptsByTaskId('existing')).length, 1);

      response = await fetch(`${base}/api/orchestrations/existing`);
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { contract: { attemptId: string } }).contract.attemptId, continued.attempt.id);
      assert.equal(await repo.count(), 3);
    });
  } finally { db.close(); }
});

test('orchestration idempotency binds related item and validation has no relationship side effects', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('one'));
    await repo.create(task('two'));
    await withApi(repo, async (base) => {
      const headers = { 'content-type': 'application/json', 'idempotency-key': 'relation-contract' };
      let response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body: JSON.stringify({ project: 'alpha', agent: 'hermes', title: 'Child', relatedItem: 'one', autoStart: false }) });
      assert.equal(response.status, 201);
      const child = (await response.json() as { task: Task }).task;
      response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body: JSON.stringify({ project: 'alpha', agent: 'hermes', title: 'Child', relatedItem: 'two', autoStart: false }) });
      assert.equal(response.status, 409);
      assert.deepEqual((await repo.getRelationships(child.id)).map((item) => item.relatedTaskId), ['one']);

      response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid-continuation' }, body: JSON.stringify({ project: 'alpha', task: 'one', relatedItem: 'two', description: 'x'.repeat(100_001), autoStart: false }) });
      assert.equal(response.status, 400);
      assert.deepEqual(await repo.getRelationships('one'), [{ taskId: 'one', relatedTaskId: child.id, type: 'related', createdAt: (await repo.getRelationships('one'))[0].createdAt }]);
      assert.equal((await repo.getAttemptsByTaskId('one')).length, 0);
    });
  } finally { db.close(); }
});

test('Postgres repository canonicalizes relationship writes and replays conflicts', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let inserted = false;
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT INTO task_relationships')) {
        if (!inserted) { inserted = true; return { rows: [{ created_at: '44' }], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('SELECT created_at FROM task_relationships')) return { rows: [{ created_at: '44' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const repo = new PostgresTaskRepository(pool as never);
  assert.equal((await repo.createRelationship('z-task', 'a-task', 44)).created, true);
  assert.equal((await repo.createRelationship('a-task', 'z-task', 99)).created, false);
  const inserts = calls.filter(({ sql }) => sql.startsWith('INSERT INTO task_relationships'));
  assert.deepEqual(inserts[0].params, ['a-task', 'z-task', 44]);
  assert.match(inserts[0].sql, /a\.project_id=b\.project_id/);
});
