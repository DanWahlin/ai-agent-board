import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import pg from 'pg';
import { PostgresConversationRepository } from '../src/repositories/postgres-conversations.js';
import { PostgresTaskRepository } from '../src/repositories/postgres.js';
import { createConversationsRouter } from '../src/routes/conversations.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { initPostgresDatabase } from '../src/db.js';
import type { Task, ExecutionAttempt } from '../src/types.js';

const PG_URL = process.env.TEST_PG_URL || 'postgresql://testuser:testpass@127.0.0.1:5499/conversation_test';

interface PgTestContext {
  base: string;
  pool: pg.Pool;
  server: ReturnType<typeof createServer>;
  convRepo: PostgresConversationRepository;
}

async function dropAllConversationTables(pool: pg.Pool) {
  await pool.query('DROP TABLE IF EXISTS conversation_epoch_fences CASCADE');
  await pool.query('DROP TABLE IF EXISTS conversation_voice_claims CASCADE');
  await pool.query('DROP TABLE IF EXISTS conversation_task_links CASCADE');
  await pool.query('DROP TABLE IF EXISTS conversation_provider_sessions CASCADE');
  await pool.query('DROP TABLE IF EXISTS conversation_summaries CASCADE');
  await pool.query('DROP TABLE IF EXISTS conversation_messages CASCADE');
  await pool.query('DROP TABLE IF EXISTS conversations CASCADE');
}

async function withPgTestServer(
  serviceTokens: Array<{ token: string; scopes: string[] }> = [{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }],
  run: (ctx: PgTestContext) => Promise<void>,
): Promise<void> {
  const pool = new pg.Pool({ connectionString: PG_URL });

  // Clean slate
  await dropAllConversationTables(pool);
  await initPostgresDatabase(pool);

  const convRepo = new PostgresConversationRepository(pool);

  // Minimal mock task repo for link tests
  const taskRepo = {
    getById: async (id: string) => id === 'task-1' ? { id: 'task-1', title: 'Test Task' } : null,
  } as any;

  const oldApiKey = process.env.API_KEY;
  const oldTokens = process.env.SERVICE_TOKENS;
  delete process.env.API_KEY;
  process.env.SERVICE_TOKENS = JSON.stringify(serviceTokens);

  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.use('/api/conversations', createConversationsRouter(convRepo, taskRepo));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  try {
    await run({ base: `http://127.0.0.1:${address.port}/api/conversations`, pool, server, convRepo });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await dropAllConversationTables(pool);
    await pool.end();
    if (oldApiKey !== undefined) process.env.API_KEY = oldApiKey; else delete process.env.API_KEY;
    if (oldTokens !== undefined) process.env.SERVICE_TOKENS = oldTokens; else delete process.env.SERVICE_TOKENS;
  }
}

function headers(token: string, principalId: string, extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-principal-id': principalId,
    'content-type': 'application/json',
    ...extra,
  };
}

const TOKEN = 'test-conv-token';
const PRINCIPAL = 'principal-alice';
const OTHER_PRINCIPAL = 'principal-bob';
const serial = { concurrency: false } as const;

// ─── PostgreSQL migration idempotency ─────────────────────────────────────────

test('[PG] migration is idempotent', serial, async () => {
  const pool = new pg.Pool({ connectionString: PG_URL });
  try {
    await dropAllConversationTables(pool);
    await initPostgresDatabase(pool);
    await initPostgresDatabase(pool); // second run must not error
    const { rows } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE tablename LIKE 'conversation%'"
    );
    assert.ok(rows.length >= 6);
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='execution_attempts' AND column_name IN ('orchestration_mode','execution_input')"
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name).sort(), ['execution_input', 'orchestration_mode']);
    const constraint = await pool.query(
      "SELECT 1 FROM pg_constraint WHERE conname='execution_attempts_orchestration_mode_check' AND conrelid='execution_attempts'::regclass"
    );
    assert.equal(constraint.rowCount, 1);
  } finally {
    await dropAllConversationTables(pool);
    await pool.end();
  }
});

test('[PG] idempotency index is principal-scoped', serial, async () => {
  const pool = new pg.Pool({ connectionString: PG_URL });
  try {
    await dropAllConversationTables(pool);
    await initPostgresDatabase(pool);
    const { rows } = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_conversations_idempotency'"
    );
    assert.ok(rows.length > 0);
    assert.ok(rows[0].indexdef.includes('principal_id'));
  } finally {
    await dropAllConversationTables(pool);
    await pool.end();
  }
});

// ─── Core contract on PostgreSQL ──────────────────────────────────────────────

test('[PG] create and idempotency', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const h = { ...headers(TOKEN, PRINCIPAL), 'idempotency-key': 'idem-pg-1' };
    const res1 = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ title: 'PG Conv' }) });
    assert.equal(res1.status, 201);
    const conv = await res1.json();

    const res2 = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ title: 'PG Conv' }) });
    assert.equal(res2.status, 200);
    const conv2 = await res2.json();
    assert.equal(conv.id, conv2.id);

    // Changed payload -> 409
    const res3 = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Different' }) });
    assert.equal(res3.status, 409);
  });
});

test('[PG] task links advance attempts only for the same source message', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, convRepo }) => {
    const response = await fetch(base, {
      method: 'POST', headers: headers(TOKEN, PRINCIPAL), body: JSON.stringify({ title: 'Attempt links' }),
    });
    assert.equal(response.status, 201);
    const conversation = await response.json();
    const first = {
      conversationId: conversation.id, taskId: 'task-1', messageId: 'message-1',
      attemptId: 'attempt-1', createdAt: 1,
    };
    assert.equal((await convRepo.linkTask(conversation.id, PRINCIPAL, first)).created, true);
    assert.equal((await convRepo.linkTask(conversation.id, PRINCIPAL, first)).link.attemptId, 'attempt-1');

    const advanced = { ...first, attemptId: 'attempt-2', createdAt: 2 };
    const result = await convRepo.linkTask(conversation.id, PRINCIPAL, advanced);
    assert.equal(result.created, false);
    assert.equal(result.link.attemptId, 'attempt-2');
    assert.equal((await convRepo.getLinkedTasks(conversation.id, PRINCIPAL))[0]?.attemptId, 'attempt-2');

    const legacyReplay = await convRepo.linkTask(conversation.id, PRINCIPAL, {
      ...advanced, attemptId: undefined, createdAt: 3,
    });
    assert.equal(legacyReplay.link.attemptId, 'attempt-2');
    assert.equal((await convRepo.getLinkedTasks(conversation.id, PRINCIPAL))[0]?.attemptId, 'attempt-2');

    await assert.rejects(
      convRepo.linkTask(conversation.id, PRINCIPAL, { ...advanced, messageId: 'message-2', attemptId: 'attempt-3' }),
      /TASK_LINK_CONFLICT/,
    );
    assert.equal((await convRepo.getLinkedTasks(conversation.id, PRINCIPAL))[0]?.attemptId, 'attempt-2');
  });
});

test('[PG] principal-scoped idempotency', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const h1 = { ...headers(TOKEN, PRINCIPAL), 'idempotency-key': 'shared-pg-key' };
    const h2 = { ...headers(TOKEN, OTHER_PRINCIPAL), 'idempotency-key': 'shared-pg-key' };

    const res1 = await fetch(base, { method: 'POST', headers: h1, body: JSON.stringify({ title: 'Alice' }) });
    assert.equal(res1.status, 201);

    const res2 = await fetch(base, { method: 'POST', headers: h2, body: JSON.stringify({ title: 'Bob' }) });
    assert.equal(res2.status, 201);

    const conv1 = await res1.json();
    const conv2 = await res2.json();
    assert.notEqual(conv1.id, conv2.id);
  });
});

test('[PG] cross-principal isolation', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'Private' }),
    });
    const conv = await res.json();

    const getRes = await fetch(`${base}/${conv.id}`, { headers: headers(TOKEN, OTHER_PRINCIPAL) });
    assert.equal(getRes.status, 404);
  });
});

test('[PG] voice claim and append with epoch fencing', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'Epoch Test' }),
    });
    const conv = await res.json();
    // AgentMic epochs use microsecond-scale wall time plus an in-process
    // monotonic counter. Keep this above PostgreSQL INT32 to catch schema drift.
    const epoch1 = 1_787_707_709_757_000;
    const epoch2 = epoch1 + 1;
    const epoch3 = epoch2 + 1;

    // Acquire the first large claim epoch
    const c1 = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: epoch1 }),
    });
    assert.equal(c1.status, 200);
    const claim = await c1.json();
    assert.equal(claim.epoch, epoch1);
    assert.equal(typeof claim.epoch, 'number');

    const begin = await fetch(`${base}/${conv.id}/provider-sessions`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: epoch1, provider: 'xai' }),
    });
    assert.equal(begin.status, 201);
    const providerSession = await begin.json();
    assert.equal(providerSession.epoch, epoch1);
    assert.equal(typeof providerSession.epoch, 'number');

    // Append with valid claim
    const a1 = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: epoch1, messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello' }] }),
    });
    assert.equal(a1.status, 200);

    // Takeover to the next epoch
    const c2 = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: epoch2 }),
    });
    assert.equal(c2.status, 200);

    // Stale first epoch append rejected
    const a2 = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: epoch1, messages: [{ id: 'm2', role: 'user', kind: 'typed', text: 'Stale' }] }),
    });
    assert.equal(a2.status, 409);

    // Release the current epoch
    const rel = await fetch(`${base}/${conv.id}/voice-claims/${epoch2}`, {
      method: 'DELETE',
      headers: headers(TOKEN, PRINCIPAL),
    });
    assert.equal(rel.status, 204);

    // Cannot reuse the released epoch (fence)
    const c3 = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: epoch2 }),
    });
    assert.equal(c3.status, 409);

    // A greater epoch works
    const c4 = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: epoch3 }),
    });
    assert.equal(c4.status, 200);
  });
});

test('[PG] append without claim rejected', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'No Claim' }),
    });
    const conv = await res.json();

    const a = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello' }] }),
    });
    assert.equal(a.status, 409);
    const body = await a.json();
    assert.equal(body.error, 'NO_VOICE_CLAIM');
  });
});

test('[PG] client event replay conflict', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'Replay' }),
    });
    const conv = await res.json();

    await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1 }),
    });

    await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello', clientEventId: 'evt-1' }] }),
    });

    // Same payload replay = OK
    const r2 = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, messages: [{ id: 'm2', role: 'user', kind: 'typed', text: 'Hello', clientEventId: 'evt-1' }] }),
    });
    assert.equal(r2.status, 200);

    // Changed payload = 409
    const r3 = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, messages: [{ id: 'm3', role: 'user', kind: 'typed', text: 'Different', clientEventId: 'evt-1' }] }),
    });
    assert.equal(r3.status, 409);
    const body = await r3.json();
    assert.equal(body.error, 'CLIENT_EVENT_CONFLICT');
  });
});

test('[PG] delete distinguishes 404 vs 409', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'Delete Test' }),
    });
    const conv = await res.json();

    // Wrong revision -> 409
    const r1 = await fetch(`${base}/${conv.id}`, {
      method: 'DELETE',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': '999' },
    });
    assert.equal(r1.status, 409);

    // Cross-principal -> 404
    const r2 = await fetch(`${base}/${conv.id}`, {
      method: 'DELETE',
      headers: { ...headers(TOKEN, OTHER_PRINCIPAL), 'if-match': String(conv.revision) },
    });
    assert.equal(r2.status, 404);

    // Correct -> 204
    const r3 = await fetch(`${base}/${conv.id}`, {
      method: 'DELETE',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(conv.revision) },
    });
    assert.equal(r3.status, 204);
  });
});

test('[PG] concurrent create with same idempotency key', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const h = { ...headers(TOKEN, PRINCIPAL), 'idempotency-key': 'concurrent-key' };
    const promises = Array.from({ length: 5 }, () =>
      fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Race' }) })
    );
    const results = await Promise.all(promises);
    const statuses = results.map(r => r.status);
    // Exactly one 201, rest 200
    assert.equal(statuses.filter(s => s === 201).length, 1);
    assert.equal(statuses.filter(s => s === 200).length, 4);
  });
});

test('[PG] search returns results', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    await fetch(base, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'Unique PG Search Title' }),
    });

    const res = await fetch(`${base}/search?q=Unique%20PG`, { headers: headers(TOKEN, PRINCIPAL) });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.conversations.length, 1);
  });
});

test('[PG] monotonic sequence across appends', serial, async () => {
  await withPgTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'Seq Test' }),
    });
    const conv = await res.json();

    await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1 }),
    });

    // First batch
    const a1 = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'A' }, { id: 'm2', role: 'assistant', kind: 'typed', text: 'B' }] }),
    });
    const r1 = await a1.json();
    assert.equal(r1.messages[0].seq, 1);
    assert.equal(r1.messages[1].seq, 2);

    // Second batch
    const a2 = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, messages: [{ id: 'm3', role: 'user', kind: 'typed', text: 'C' }] }),
    });
    const r2 = await a2.json();
    assert.equal(r2.messages[0].seq, 3);
    assert.equal(r2.persistedThroughSeq, 3);
  });
});

test('[PG] agent-default context and cancellation CAS preserve a concurrent successor', serial, async () => {
  await withPgTestServer([], async ({ pool }) => {
    const repo = new PostgresTaskRepository(pool);
    const id = `pg-agent-default-${Date.now()}`;
    await pool.query(`INSERT INTO projects(id,name,is_default,created_at,updated_at)
      VALUES($1,$2,false,$3,$3) ON CONFLICT(id) DO NOTHING`, [id, id, Date.now()]);
    const task: Task = {
      id, projectId: id, title: 'PG agent-default', description: 'visible', priority: 'medium',
      columnId: 'backlog', agentStatus: 'idle', agentType: 'hermes', createdAt: Date.now(), useWorktree: false,
      externalSource: 'hermes', externalKey: `${id}-task`,
    };
    const attempt = (suffix: string): ExecutionAttempt => ({
      id: `${id}-${suffix}`, taskId: id, externalSource: 'hermes', externalKey: `${id}-${suffix}`,
      titleSnapshot: task.title, descriptionSnapshot: task.description, agentType: 'hermes', autoStart: false,
      requestSnapshot: '{}', status: 'pending', createdAt: Date.now(),
    });
    const first = attempt('a');
    const second = attempt('b');
    try {
      await repo.createOrchestration(task, first, {
        attemptId: first.id, agentType: 'hermes', orchestrationMode: 'agent-default', executionInput: 'first private',
      });
      assert.deepEqual(await repo.getCurrentExecution(id), {
        attemptId: first.id, agentType: 'hermes', orchestrationMode: 'agent-default', executionInput: 'first private',
      });

      const [cancelledFirst, continued] = await Promise.all([
        repo.cancelCurrentAttempt(id, first.id),
        repo.continueOrchestration(id, { agentStatus: 'idle' }, second, {
          attemptId: second.id, agentType: 'hermes', orchestrationMode: 'agent-default', executionInput: 'second private',
        }),
      ]);
      assert.equal(continued?.created, true);
      assert.ok(cancelledFirst === undefined || cancelledFirst.agentStatus === 'failed');
      assert.deepEqual(await repo.getCurrentExecution(id), {
        attemptId: second.id, agentType: 'hermes', orchestrationMode: 'agent-default', executionInput: 'second private',
      });
      assert.equal((await repo.getById(id))?.agentStatus, 'idle');
      assert.equal((await repo.cancelCurrentAttempt(id, first.id)), undefined);
      assert.equal((await repo.cancelCurrentAttempt(id, second.id))?.agentStatus, 'failed');
    } finally {
      await pool.query('DELETE FROM tasks WHERE id=$1', [id]);
      await pool.query('DELETE FROM projects WHERE id=$1', [id]);
    }
  });
});
