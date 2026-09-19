import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { migrateSqliteDatabase } from '../src/db.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { createOrchestrationsRouter } from '../src/routes/orchestrations.js';
import { createAgentRouter } from '../src/routes/agent.js';
import type { Project } from '../src/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import type { AttemptExecutionContext } from '../src/repositories/types.js';

const project: Project = { id: 'voice', name: 'Voice', isDefault: false, createdAt: 1, updatedAt: 1 };
const projects = {
  resolve: async (reference: string) => reference === 'voice' ? [project] : [],
  getById: async (id: string) => id === project.id ? project : undefined,
} as ProjectRepository;

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrateSqliteDatabase(db);
  db.prepare(`INSERT INTO projects (id,name,repo_path,is_default,created_at,updated_at)
    VALUES ('voice','Voice',NULL,0,1,1)`).run();
  return { db, repo: new SqliteTaskRepository(db) };
}

async function withApi(
  repo: SqliteTaskRepository,
  manager: AgentManager,
  run: (base: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use('/api/orchestrations', createOrchestrationsRouter(repo, projects, manager));
  app.use('/api/tasks', createAgentRouter(repo, manager));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function manager(captured: AttemptExecutionContext[] = [], stopped: string[] = []) {
  return {
    getAvailableAgents: () => [{ name: 'hermes', displayName: 'Hermes', available: true }],
    isRunning: () => false,
    resetEvents: () => {},
    startAgent: (_task: unknown, _status: unknown, _worktree: unknown, context: AttemptExecutionContext) => {
      captured.push(context);
      return true;
    },
    stopAgent: async (taskId: string, attemptId?: string) => { stopped.push(`${taskId}:${attemptId ?? ''}`); return true; },
  } as unknown as AgentManager;
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('migration adds private attempt context and legacy tasks default to coding', async () => {
  const { db, repo } = setup();
  try {
    const taskColumns = new Set((db.pragma('table_info(tasks)') as Array<{ name: string }>).map((row) => row.name));
    const attemptColumns = new Set((db.pragma('table_info(execution_attempts)') as Array<{ name: string }>).map((row) => row.name));
    assert.ok(taskColumns.has('current_attempt_id'));
    assert.ok(attemptColumns.has('orchestration_mode'));
    assert.ok(attemptColumns.has('execution_input'));
    db.prepare(`INSERT INTO tasks (id,project_id,title,description,priority,column_id,agent_status,agent_type,created_at)
      VALUES ('legacy','default','Legacy','','medium','backlog','idle','hermes',1)`).run();
    assert.deepEqual(await repo.getCurrentExecution('legacy'), { orchestrationMode: 'coding' });
  } finally { db.close(); }
});

test('agent-default API persists exact private input without exposing it and dispatches the exact current attempt', async () => {
  const { db, repo } = setup();
  const captured: AttemptExecutionContext[] = [];
  const secret = '  exact input\nwith <tags> and trailing spaces  ';
  try {
    await withApi(repo, manager(captured), async (base) => {
      const capability = await fetch(`${base}/api/orchestrations/capabilities`);
      assert.equal(capability.status, 200);
      const advertised = await capability.json() as { executionModes: string[]; cancellation: { exactAttempt: boolean } };
      assert.deepEqual(advertised.executionModes, ['coding', 'agent-default']);
      assert.equal(advertised.cancellation.exactAttempt, true);

      const headers = { 'content-type': 'application/json', 'idempotency-key': 'voice-1' };
      let response = await fetch(`${base}/api/orchestrations`, {
        method: 'POST', headers,
        body: JSON.stringify({ project: 'voice', agent: 'hermes', title: 'Visible title', description: 'Visible request', executionMode: 'agent-default', executionInput: secret }),
      });
      assert.equal(response.status, 201);
      const responseText = await response.text();
      assert.equal(responseText.includes('exact input'), false);
      const body = JSON.parse(responseText) as { task: Record<string, unknown>; attempt: Record<string, unknown>; contract: { taskId: string } };
      assert.equal('executionInput' in body.task, false);
      assert.equal('orchestrationMode' in body.attempt, false);
      assert.equal(body.task.repoPath, undefined);
      assert.equal(body.task.useWorktree, false);

      await nextTurn();
      assert.deepEqual(captured, [{ attemptId: body.attempt.id, orchestrationMode: 'agent-default', executionInput: secret }]);
      assert.deepEqual(await repo.getCurrentExecution(body.contract.taskId), captured[0]);
      const raw = db.prepare('SELECT orchestration_mode,execution_input FROM execution_attempts WHERE id=?').get(body.attempt.id) as Record<string, unknown>;
      assert.deepEqual(raw, { orchestration_mode: 'agent-default', execution_input: secret });

      response = await fetch(`${base}/api/orchestrations`, {
        method: 'POST', headers,
        body: JSON.stringify({ project: 'voice', agent: 'hermes', title: 'Visible title', description: 'Visible request', executionMode: 'agent-default', executionInput: `${secret}!` }),
      });
      assert.equal(response.status, 409);
    });
  } finally { db.close(); }
});

test('agent-default continuation replaces context and retry copies the exact failed attempt context', async () => {
  const { db, repo } = setup();
  const captured: AttemptExecutionContext[] = [];
  try {
    await withApi(repo, manager(captured), async (base) => {
      const send = (key: string, body: Record<string, unknown>) => fetch(`${base}/api/orchestrations`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
      });
      let response = await send('initial', { project: 'voice', agent: 'hermes', title: 'Continue me', description: 'visible',
        executionMode: 'agent-default', executionInput: 'first', autoStart: false });
      assert.equal(response.status, 201);
      const created = await response.json() as { task: { id: string } };

      response = await send('continuation', { project: 'voice', task: created.task.id, executionInput: 'second\nexact', autoStart: false });
      assert.equal(response.status, 202);
      const continued = await response.json() as { attempt: { id: string } };
      assert.deepEqual(await repo.getCurrentExecution(created.task.id), {
        attemptId: continued.attempt.id, orchestrationMode: 'agent-default', executionInput: 'second\nexact',
      });

      await repo.update(created.task.id, { agentStatus: 'failed' });
      response = await fetch(`${base}/api/orchestrations/${created.task.id}/retry`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'retry' }, body: '{}',
      });
      assert.equal(response.status, 202);
      const retried = await response.json() as { attempt: { id: string } };
      await nextTurn();
      assert.deepEqual(captured.at(-1), {
        attemptId: retried.attempt.id, orchestrationMode: 'agent-default', executionInput: 'second\nexact',
      });
    });
  } finally { db.close(); }
});

test('manual start of a pending agent-default attempt loads its private execution context', async () => {
  const { db, repo } = setup();
  const captured: AttemptExecutionContext[] = [];
  try {
    await withApi(repo, manager(captured), async (base) => {
      const response = await fetch(`${base}/api/orchestrations`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'pending-start' },
        body: JSON.stringify({ project: 'voice', agent: 'hermes', title: 'Pending',
          executionMode: 'agent-default', executionInput: 'private pending input', autoStart: false }),
      });
      assert.equal(response.status, 201);
      const created = await response.json() as { task: { id: string }; attempt: { id: string } };
      const started = await fetch(`${base}/api/tasks/${created.task.id}/run`, { method: 'POST' });
      assert.equal(started.status, 200);
      assert.deepEqual(captured, [{
        attemptId: created.attempt.id, orchestrationMode: 'agent-default', executionInput: 'private pending input',
      }]);
    });
  } finally { db.close(); }
});

test('retrying an addressed historical attempt copies that attempt context, not the latest attempt', async () => {
  const { db, repo } = setup();
  const captured: AttemptExecutionContext[] = [];
  try {
    await withApi(repo, manager(captured), async (base) => {
      const send = (key: string, body: Record<string, unknown>) => fetch(`${base}/api/orchestrations`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
      });
      let response = await send('history-first', { project: 'voice', agent: 'hermes', title: 'History',
        executionMode: 'agent-default', executionInput: 'first private input', autoStart: false });
      assert.equal(response.status, 201);
      const first = await response.json() as { task: { id: string }; attempt: { id: string } };
      response = await send('history-second', { project: 'voice', task: first.task.id,
        executionInput: 'second private input', autoStart: false });
      assert.equal(response.status, 202);
      await repo.update(first.task.id, { agentStatus: 'failed' });

      response = await fetch(`${base}/api/orchestrations/${first.attempt.id}/retry`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'history-retry' }, body: '{}',
      });
      assert.equal(response.status, 202);
      await nextTurn();
      assert.equal(captured.at(-1)?.executionInput, 'first private input');
    });
  } finally { db.close(); }
});

test('agent-default validation rejects oversized or contradictory coding fields while coding remains the default', async () => {
  const { db, repo } = setup();
  try {
    await withApi(repo, manager(), async (base) => {
      const post = (key: string, body: Record<string, unknown>) => fetch(`${base}/api/orchestrations`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
      });
      assert.equal((await post('too-long', { project: 'voice', agent: 'hermes', title: 'x', executionMode: 'agent-default', executionInput: 'x'.repeat(4001) })).status, 400);
      assert.equal((await post('branch', { project: 'voice', agent: 'hermes', title: 'x', executionMode: 'agent-default', executionInput: 'x', branchName: 'agent/x' })).status, 400);
      assert.equal((await post('coding-input', { project: 'voice', agent: 'hermes', title: 'x', executionInput: 'private' })).status, 400);
      assert.equal((await post('coding-default', { project: 'voice', agent: 'hermes', title: 'x' })).status, 409);
    });
  } finally { db.close(); }
});

test('cancellation is fenced to the exact current attempt', async () => {
  const { db, repo } = setup();
  const stopped: string[] = [];
  try {
    await withApi(repo, manager([], stopped), async (base) => {
      const send = (key: string, body: Record<string, unknown>) => fetch(`${base}/api/orchestrations`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
      });
      let response = await send('cancel-initial', { project: 'voice', agent: 'hermes', title: 'Cancel me',
        executionMode: 'agent-default', executionInput: 'first', autoStart: false });
      assert.equal(response.status, 201);
      const initial = await response.json() as { task: { id: string }; attempt: { id: string } };

      response = await send('cancel-continuation', { project: 'voice', task: initial.task.id,
        executionInput: 'second', autoStart: false });
      assert.equal(response.status, 202);
      const current = await response.json() as { attempt: { id: string } };

      const cancel = (attemptId: string) => fetch(`${base}/api/orchestrations/${initial.task.id}/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attemptId }),
      });
      assert.equal((await cancel(initial.attempt.id)).status, 409);
      assert.deepEqual(stopped, []);
      response = await cancel(current.attempt.id);
      assert.equal(response.status, 200);
      assert.deepEqual(stopped, [`${initial.task.id}:${current.attempt.id}`]);
      const result = await response.json() as { task: { agentStatus: string }; contract: { attemptId: string } };
      assert.equal(result.task.agentStatus, 'failed');
      assert.equal(result.contract.attemptId, current.attempt.id);
    });
  } finally { db.close(); }
});
