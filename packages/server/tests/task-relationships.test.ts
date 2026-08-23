import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { PostgresTaskRepository } from '../src/repositories/postgres.js';
import { createTaskRouter } from '../src/routes/tasks.js';
import { createOrchestrationsRouter } from '../src/routes/orchestrations.js';
import type { Task, Project, ExecutionAttempt } from '../src/types.js';
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
      request_snapshot TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(external_source, external_key));
  `);
  return db;
}

const task = (id: string, projectId = 'project-a', title = id): Task => ({
  id, projectId, title, description: '', priority: 'medium', columnId: 'backlog', agentStatus: 'idle',
  agentType: 'hermes', createdAt: Number(id.replace(/\D/g, '')) || 1, repoPath: '/repo', baseBranch: 'main',
  branchName: `agent/${id}`, useWorktree: true,
});

const attempt = (id: string, taskId: string, key = id): ExecutionAttempt => ({
  id, taskId, externalSource: 'hermes', externalKey: key, titleSnapshot: taskId,
  descriptionSnapshot: '', agentType: 'hermes', autoStart: false, requestSnapshot: '{}',
  status: 'pending', createdAt: 1,
});

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

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
  startAgent: () => undefined,
} as unknown as AgentManager;

async function withApi(repo: SqliteTaskRepository, run: (base: string) => Promise<void>, manager: AgentManager = agents, projectRepo: ProjectRepository = projects) {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createTaskRouter(repo, manager, projectRepo));
  app.use('/api/orchestrations', createOrchestrationsRouter(repo, projectRepo, manager));
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
    const messages: Array<[string, string]> = [];
    const manager = { ...agents, sendMessage: async (taskId: string, message: string) => { messages.push([taskId, message]); return true; } } as unknown as AgentManager;
    await withApi(repo, async (base) => {
      let response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'new-work-1' }, body: JSON.stringify({ project: 'alpha', agent: 'hermes', title: 'New work', relatedItem: 'existing', autoStart: false, provenance: { hermesTaskId: 'hermes-parent-1' } }) });
      assert.equal(response.status, 201);
      const created = await response.json() as { task: Task; attempt: ExecutionAttempt };
      assert.ok(created.attempt.id);
      assert.equal(created.task.provenance?.sourceTask, 'hermes-parent-1');
      assert.equal(JSON.parse(created.attempt.requestSnapshot).provenance.sourceTask, 'hermes-parent-1');
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

      response = await fetch(`${base}/api/orchestrations/existing/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '  status please  ' }) });
      assert.equal(response.status, 200);
      assert.deepEqual(messages, [['existing', 'status please']]);

      response = await fetch(`${base}/api/orchestrations/existing`);
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { contract: { attemptId: string } }).contract.attemptId, continued.attempt.id);
      assert.equal(await repo.count(), 3);
    }, manager);
  } finally { db.close(); }
});

test('create replay returns the durable attempt even when agent readiness changes', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  let available = true;
  let dispatches = 0;
  const manager = {
    ...agents,
    getAvailableAgents: () => [{ name: 'hermes', displayName: 'Hermes', available }],
    startAgent: () => { dispatches += 1; },
  } as unknown as AgentManager;
  try {
    await withApi(repo, async (base) => {
      const headers = { 'content-type': 'application/json', 'idempotency-key': 'readiness-replay' };
      const body = JSON.stringify({ project: 'alpha', agent: 'hermes', title: 'Durable replay', autoStart: true });
      let response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body });
      assert.equal(response.status, 201);
      const created = await response.json() as { task: Task; attempt: ExecutionAttempt };
      await nextTurn();
      assert.equal(dispatches, 1);

      available = false;
      response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('idempotent-replay'), 'true');
      const replayed = await response.json() as { task: Task; attempt: ExecutionAttempt };
      assert.equal(replayed.task.id, created.task.id);
      assert.equal(replayed.attempt.id, created.attempt.id);
      assert.equal(dispatches, 1);
    }, manager);
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

test('retry requires idempotency, creates one attempt, and never redispatches a replay or conflict', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  let dispatches = 0;
  const manager = { ...agents, startAgent: () => { dispatches += 1; } } as unknown as AgentManager;
  try {
    await repo.create(task('retry-card', 'project-a', 'Retry card'));
    await withApi(repo, async (base) => {
      let response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'initial-attempt' }, body: JSON.stringify({ project: 'alpha', task: 'retry-card', description: 'failed work', autoStart: false }) });
      assert.equal(response.status, 202);
      const initial = await response.json() as { attempt: ExecutionAttempt };
      await repo.update('retry-card', { agentStatus: 'failed' });

      response = await fetch(`${base}/api/orchestrations/retry-card/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 400);
      assert.match((await response.json() as { error: string }).error, /Idempotency-Key/);

      const retryHeaders = { 'content-type': 'application/json', 'idempotency-key': 'retry-attempt' };
      response = await fetch(`${base}/api/orchestrations/retry-card/retry`, { method: 'POST', headers: retryHeaders, body: JSON.stringify({ provenance: { sourceSession: 'one' } }) });
      assert.equal(response.status, 202);
      const retried = await response.json() as { attempt: ExecutionAttempt };
      assert.notEqual(retried.attempt.id, initial.attempt.id);
      await nextTurn();
      assert.equal(dispatches, 1);
      assert.equal((await repo.getAttemptsByTaskId('retry-card')).length, 2);

      await repo.update('retry-card', { title: 'Retry card renamed', description: 'mutated', priority: 'high',
        agentType: 'codex', baseBranch: 'develop', branchName: 'agent/mutated', timeoutMinutes: 120 });
      response = await fetch(`${base}/api/orchestrations/retry-card/retry`, { method: 'POST', headers: retryHeaders, body: JSON.stringify({ provenance: { sourceSession: 'one' } }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('idempotent-replay'), 'true');
      assert.equal((await response.json() as { attempt: ExecutionAttempt }).attempt.id, retried.attempt.id);
      await nextTurn();
      assert.equal(dispatches, 1);
      assert.equal((await repo.getAttemptsByTaskId('retry-card')).length, 2);

      response = await fetch(`${base}/api/orchestrations/retry-card/retry`, { method: 'POST', headers: retryHeaders, body: JSON.stringify({ provenance: { sourceSession: 'changed' } }) });
      assert.equal(response.status, 409);
      await nextTurn();
      assert.equal(dispatches, 1);
      assert.equal((await repo.getAttemptsByTaskId('retry-card')).length, 2);
    }, manager);
  } finally { db.close(); }
});

test('request snapshots reject create and continuation replays with changed priority or provenance', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('snapshot-card', 'project-a', 'Snapshot card'));
    await withApi(repo, async (base) => {
      for (const [key, changed] of [
        ['create-priority', { priority: 'high' }],
        ['create-provenance', { provenance: { sourceSession: 'changed' } }],
      ] as const) {
        const original = { project: 'alpha', agent: 'hermes', title: `Create ${key}`, autoStart: false, priority: 'medium', provenance: { sourceSession: 'original' } };
        const headers = { 'content-type': 'application/json', 'idempotency-key': key };
        let response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body: JSON.stringify(original) });
        assert.equal(response.status, 201);
        response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body: JSON.stringify({ ...original, ...changed }) });
        assert.equal(response.status, 409, key);
      }

      for (const [key, changed] of [
        ['continue-priority', { priority: 'high' }],
        ['continue-provenance', { provenance: { sourceSession: 'changed' } }],
      ] as const) {
        const original = { project: 'alpha', task: 'snapshot-card', description: key, autoStart: false, priority: 'medium', provenance: { sourceSession: 'original' } };
        const headers = { 'content-type': 'application/json', 'idempotency-key': key };
        let response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body: JSON.stringify(original) });
        assert.equal(response.status, 202);
        response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body: JSON.stringify({ ...original, ...changed }) });
        assert.equal(response.status, 409, key);
      }
    });
  } finally { db.close(); }
});

test('persisted request identity authoritatively replays after task and project mutation', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  let projectAvailable = true;
  const mutableProjects = {
    getById: async (id: string) => projectAvailable && id === project.id ? project : undefined,
    resolve: async (ref: string) => projectAvailable && ref === 'old-project-alias' ? [project] : [],
  } as ProjectRepository;
  try {
    await repo.create({ ...task('mutable-card', 'project-a', 'Old title'), description: 'old default', priority: 'medium' });
    await withApi(repo, async (base) => {
      const headers = { 'content-type': 'application/json', 'idempotency-key': 'durable-continuation' };
      const original = { project: 'old-project-alias', task: 'Old title', autoStart: false };
      let response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body: JSON.stringify(original) });
      assert.equal(response.status, 202);
      const first = await response.json() as { attempt: ExecutionAttempt };

      await repo.update('mutable-card', { title: 'Renamed', description: 'changed default', priority: 'high', agentType: 'codex', baseBranch: 'develop' });
      projectAvailable = false;
      response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers, body: JSON.stringify(original) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('idempotent-replay'), 'true');
      assert.equal((await response.json() as { attempt: ExecutionAttempt }).attempt.id, first.attempt.id);

      response = await fetch(`${base}/api/orchestrations`, { method: 'POST', headers,
        body: JSON.stringify({ ...original, description: 'materially different' }) });
      assert.equal(response.status, 409);
    }, agents, mutableProjects);
  } finally { db.close(); }
});

test('queued continuation cannot overwrite durable active execution state', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    const active = { ...task('active-card', 'project-a', 'Active card'), agentStatus: 'executing' as const,
      columnId: 'in-progress' as const, runRequestedAt: 10, runClaimedAt: 11, startedAt: 12 };
    await repo.create(active);
    await withApi(repo, async (base) => {
      const response = await fetch(`${base}/api/orchestrations`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'queued-active-race' },
        body: JSON.stringify({ project: 'alpha', task: 'active-card', title: 'Must not replace', autoStart: false }) });
      assert.equal(response.status, 409);
      const persisted = await repo.getById(active.id);
      assert.deepEqual({ title: persisted?.title, status: persisted?.agentStatus, requested: persisted?.runRequestedAt, claimed: persisted?.runClaimedAt },
        { title: active.title, status: active.agentStatus, requested: active.runRequestedAt, claimed: active.runClaimedAt });
      assert.equal(await repo.getAttemptByExternalIdentity('hermes', 'queued-active-race'), undefined);
    });
  } finally { db.close(); }
});

test('SQLite locked continuation rejects a claimed idle execution', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    const active = { ...task('claimed-idle'), runRequestedAt: 10, runClaimedAt: 11 };
    await repo.create(active);
    const result = await repo.continueOrchestration(active.id, { title: 'overwritten', runRequestedAt: undefined, runClaimedAt: undefined },
      attempt('claimed-idle-attempt', active.id), undefined, 1, { requireRunnable: true });
    assert.equal(result, undefined);
    const persisted = await repo.getById(active.id);
    assert.deepEqual({ title: persisted?.title, status: persisted?.agentStatus, requested: persisted?.runRequestedAt, claimed: persisted?.runClaimedAt },
      { title: active.title, status: active.agentStatus, requested: active.runRequestedAt, claimed: active.runClaimedAt });
    assert.equal(await repo.getAttemptById('claimed-idle-attempt'), undefined);
  } finally { db.close(); }
});

test('SQLite orchestration aggregates roll back creates and continuations when relationship insertion fails', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create(task('same-project'));
    await repo.create(task('other-project', 'project-b'));

    const createdTask = { ...task('aggregate-create'), externalSource: 'hermes', externalKey: 'aggregate-create' };
    await assert.rejects(repo.createOrchestration(createdTask, attempt('create-attempt', createdTask.id, 'aggregate-create'), 'other-project', 10), /same project/);
    assert.equal(await repo.getById(createdTask.id), undefined);
    assert.equal(await repo.getAttemptById('create-attempt'), undefined);
    assert.deepEqual(await repo.getRelationships('other-project'), []);

    const before = await repo.getById('same-project');
    await assert.rejects(repo.continueOrchestration('same-project', { title: 'should roll back', priority: 'high' }, attempt('continue-attempt', 'same-project', 'aggregate-continue'), 'other-project', 11), /same project/);
    assert.deepEqual(await repo.getById('same-project'), before);
    assert.equal(await repo.getAttemptById('continue-attempt'), undefined);
    assert.deepEqual(await repo.getRelationships('same-project'), []);
  } finally { db.close(); }
});

test('SQLite continuation eligibility accepts only one distinct-key dispatch per task', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create({ ...task('race-card'), agentStatus: 'failed' });
    const updates = { agentStatus: 'idle' as const, columnId: 'in-progress' as const, runRequestedAt: 100 };
    const [first, second] = await Promise.all([
      repo.continueOrchestration('race-card', updates, { ...attempt('race-a', 'race-card', 'race-key-a'), autoStart: true, status: 'dispatched' }, undefined, 1,
        { requiredAgentStatus: 'failed', requireRunnable: true }),
      repo.continueOrchestration('race-card', updates, { ...attempt('race-b', 'race-card', 'race-key-b'), autoStart: true, status: 'dispatched' }, undefined, 1,
        { requiredAgentStatus: 'failed', requireRunnable: true }),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    assert.equal((await repo.getAttemptsByTaskId('race-card')).length, 1);
    assert.equal((await repo.getById('race-card'))?.runRequestedAt, 100);
  } finally { db.close(); }
});

test('SQLite continuation accepts a retry after a prior claimed run reached a terminal status', async () => {
  const db = makeDb();
  const repo = new SqliteTaskRepository(db);
  try {
    await repo.create({ ...task('completed-card'), agentStatus: 'failed', runRequestedAt: 50, runClaimedAt: 51 });
    const result = await repo.continueOrchestration(
      'completed-card',
      { agentStatus: 'idle', columnId: 'in-progress', runRequestedAt: 100, runClaimedAt: undefined },
      { ...attempt('retry-after-terminal', 'completed-card', 'retry-after-terminal-key'), autoStart: true, status: 'dispatched' },
      undefined,
      1,
      { requiredAgentStatus: 'failed', requireRunnable: true },
    );
    assert.equal(result?.created, true);
    assert.equal((await repo.getById('completed-card'))?.runRequestedAt, 100);
  } finally { db.close(); }
});

test('Postgres continuation locks by task and revalidates eligibility before update', async () => {
  const lockedTask = { ...task('pg-race'), agentStatus: 'idle' as const, runRequestedAt: 100 };
  const taskRow = {
    id: lockedTask.id, project_id: lockedTask.projectId, title: lockedTask.title, description: lockedTask.description,
    priority: lockedTask.priority, column_id: lockedTask.columnId, agent_status: lockedTask.agentStatus,
    agent_type: lockedTask.agentType, created_at: String(lockedTask.createdAt), started_at: null, completed_at: null,
    repo_path: lockedTask.repoPath, branch_name: lockedTask.branchName, base_branch: lockedTask.baseBranch,
    use_worktree: true, worktree_path: null, archived: false, group_id: null, group_order: null, summary: null,
    external_source: null, external_key: null, provenance: null, run_requested_at: '100', run_claimed_at: '101', timeout_minutes: null,
  };
  const proposed = { ...attempt('pg-race-attempt', lockedTask.id, 'pg-race-key'), autoStart: true, status: 'dispatched' as const };
  const attemptRow = {
    id: proposed.id, task_id: proposed.taskId, external_source: proposed.externalSource, external_key: proposed.externalKey,
    title_snapshot: proposed.titleSnapshot, description_snapshot: proposed.descriptionSnapshot, agent_type: proposed.agentType,
    related_task_id: null, auto_start: true, timeout_minutes: null, request_snapshot: proposed.requestSnapshot,
    status: proposed.status, created_at: '1',
  };
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM tasks WHERE id=$1 FOR UPDATE')) return { rows: [taskRow], rowCount: 1 };
      if (sql.startsWith('INSERT INTO execution_attempts')) return { rows: [attemptRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const repo = new PostgresTaskRepository({ connect: async () => client } as never);
  const result = await repo.continueOrchestration(lockedTask.id, { runRequestedAt: 200 }, proposed, undefined, 1, { requireRunnable: true });
  assert.equal(result, undefined);
  assert.deepEqual(calls.slice(0, 4).map(({ sql }) => sql), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    'SELECT * FROM tasks WHERE id=$1 FOR UPDATE',
  ]);
  assert.deepEqual(calls[1].params, ['task:pg-race']);
  assert.equal(calls.some(({ sql }) => sql.startsWith('UPDATE tasks')), false);
  assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
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

test('Postgres orchestration aggregate commits successful work and rolls back relation failures', async () => {
  const aggregateTask = { ...task('pg-task'), externalSource: 'hermes', externalKey: 'pg-key' };
  const aggregateAttempt = attempt('pg-attempt', aggregateTask.id, 'pg-key');
  const taskRow = {
    id: aggregateTask.id, project_id: aggregateTask.projectId, title: aggregateTask.title, description: aggregateTask.description,
    priority: aggregateTask.priority, column_id: aggregateTask.columnId, agent_status: aggregateTask.agentStatus,
    agent_type: aggregateTask.agentType, created_at: String(aggregateTask.createdAt), started_at: null, completed_at: null,
    repo_path: aggregateTask.repoPath, branch_name: aggregateTask.branchName, base_branch: aggregateTask.baseBranch,
    use_worktree: true, worktree_path: null, archived: false, group_id: null, group_order: null, summary: null,
    external_source: aggregateTask.externalSource, external_key: aggregateTask.externalKey, provenance: null,
    run_requested_at: null, run_claimed_at: null, timeout_minutes: null,
  };
  const attemptRow = {
    id: aggregateAttempt.id, task_id: aggregateTask.id, external_source: aggregateAttempt.externalSource,
    external_key: aggregateAttempt.externalKey, title_snapshot: aggregateAttempt.titleSnapshot,
    description_snapshot: aggregateAttempt.descriptionSnapshot, agent_type: aggregateAttempt.agentType,
    related_task_id: null, auto_start: false, timeout_minutes: null, request_snapshot: aggregateAttempt.requestSnapshot,
    status: aggregateAttempt.status, created_at: String(aggregateAttempt.createdAt),
  };

  for (const relationSucceeds of [true, false]) {
    const calls: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.startsWith('INSERT INTO tasks')) return { rows: [taskRow], rowCount: 1 };
        if (sql.startsWith('INSERT INTO execution_attempts')) return { rows: [attemptRow], rowCount: 1 };
        if (sql.startsWith('INSERT INTO task_relationships')) return { rows: relationSucceeds ? [{ created_at: '7' }] : [], rowCount: relationSucceeds ? 1 : 0 };
        if (sql.startsWith('SELECT 1 FROM task_relationships')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
      release: () => { released = true; },
    };
    const repo = new PostgresTaskRepository({ connect: async () => client } as never);
    if (relationSucceeds) {
      const result = await repo.createOrchestration(aggregateTask, aggregateAttempt, 'related-task', 7);
      assert.equal(result.created, true);
      assert.match(calls.find((sql) => sql.startsWith('INSERT INTO tasks')) ?? '',
        /ON CONFLICT\(external_source,external_key\)\s+WHERE external_source IS NOT NULL AND external_key IS NOT NULL\s+DO NOTHING/);
      assert.deepEqual(calls.filter((sql) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)), ['BEGIN', 'COMMIT']);
    } else {
      await assert.rejects(repo.createOrchestration(aggregateTask, aggregateAttempt, 'cross-project-task', 7), /same project/);
      assert.deepEqual(calls.filter((sql) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)), ['BEGIN', 'ROLLBACK']);
    }
    assert.equal(released, true);
  }
});

test('Postgres create orchestration checks attempt replay before writes and returns its original task', async () => {
  const proposedTask = { ...task('new-card'), externalSource: 'hermes', externalKey: 'shared-key' };
  const proposedAttempt = attempt('new-attempt', proposedTask.id, 'shared-key');
  const originalTask = { ...task('original-card'), externalSource: 'hermes', externalKey: 'original-create' };
  const originalAttempt = attempt('original-attempt', originalTask.id, 'shared-key');
  const originalTaskRow = {
    id: originalTask.id, project_id: originalTask.projectId, title: originalTask.title, description: originalTask.description,
    priority: originalTask.priority, column_id: originalTask.columnId, agent_status: originalTask.agentStatus,
    agent_type: originalTask.agentType, created_at: String(originalTask.createdAt), started_at: null, completed_at: null,
    repo_path: originalTask.repoPath, branch_name: originalTask.branchName, base_branch: originalTask.baseBranch,
    use_worktree: true, worktree_path: null, archived: false, group_id: null, group_order: null, summary: null,
    external_source: originalTask.externalSource, external_key: originalTask.externalKey, provenance: null,
    run_requested_at: null, run_claimed_at: null, timeout_minutes: null,
  };
  const originalAttemptRow = {
    id: originalAttempt.id, task_id: originalAttempt.taskId, external_source: originalAttempt.externalSource,
    external_key: originalAttempt.externalKey, title_snapshot: originalAttempt.titleSnapshot,
    description_snapshot: originalAttempt.descriptionSnapshot, agent_type: originalAttempt.agentType,
    related_task_id: null, auto_start: false, timeout_minutes: null, request_snapshot: originalAttempt.requestSnapshot,
    status: originalAttempt.status, created_at: String(originalAttempt.createdAt),
  };
  const calls: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('SELECT * FROM execution_attempts')) return { rows: [originalAttemptRow], rowCount: 1 };
      if (sql.startsWith('SELECT * FROM tasks WHERE id=')) return { rows: [originalTaskRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const repo = new PostgresTaskRepository({ connect: async () => client } as never);
  const result = await repo.createOrchestration(proposedTask, proposedAttempt, 'unrelated-card', 7);

  assert.equal(result.created, false);
  assert.equal(result.task.id, originalTask.id);
  assert.equal(result.attempt.id, originalAttempt.id);
  assert.deepEqual(calls.slice(0, 5), [
    'BEGIN',
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    'SELECT * FROM execution_attempts WHERE external_source=$1 AND external_key=$2 FOR UPDATE',
    'SELECT * FROM tasks WHERE id=$1',
    'COMMIT',
  ]);
  assert.equal(calls.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
  assert.equal(released, true);
});
