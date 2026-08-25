import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { SqliteConversationRepository } from '../src/repositories/sqlite-conversations.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { createConversationsRouter } from '../src/routes/conversations.js';
import { authMiddleware } from '../src/middleware/auth.js';

function createConversationTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      preferred_project_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      deleted_at INTEGER,
      idempotency_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_principal ON conversations(principal_id, state, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_idempotency ON conversations(idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      client_event_id TEXT,
      provider_type TEXT,
      provider_model TEXT,
      provider_session_id TEXT,
      provider_epoch INTEGER,
      provider_response_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(conversation_id, seq),
      UNIQUE(conversation_id, client_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_messages_seq ON conversation_messages(conversation_id, seq);

    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      version INTEGER NOT NULL,
      through_seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      model TEXT,
      policy TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_id, version)
    );

    CREATE TABLE IF NOT EXISTS conversation_provider_sessions (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      epoch INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      session_id TEXT,
      capabilities TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      expires_at INTEGER,
      end_reason TEXT,
      PRIMARY KEY(conversation_id, epoch)
    );

    CREATE TABLE IF NOT EXISTS conversation_task_links (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      task_id TEXT NOT NULL,
      message_id TEXT,
      attempt_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_voice_claims (
      conversation_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}

function createTasksTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      description TEXT,
      priority TEXT,
      column_id TEXT,
      agent_status TEXT,
      agent_type TEXT,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      repo_path TEXT,
      branch_name TEXT,
      base_branch TEXT,
      use_worktree INTEGER,
      worktree_path TEXT,
      archived INTEGER,
      group_id TEXT,
      group_order INTEGER,
      summary TEXT,
      external_source TEXT,
      external_key TEXT,
      provenance TEXT,
      run_requested_at INTEGER,
      run_claimed_at INTEGER,
      timeout_minutes INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS identity ON tasks(external_source, external_key) WHERE external_source IS NOT NULL AND external_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS events (
      id TEXT,
      task_id TEXT,
      type TEXT,
      content TEXT,
      timestamp INTEGER,
      metadata TEXT
    );
  `);
}

interface TestContext {
  base: string;
  db: Database.Database;
  server: ReturnType<typeof createServer>;
  convRepo: SqliteConversationRepository;
  taskRepo: SqliteTaskRepository;
}

async function withTestServer(
  serviceTokens: Array<{ token: string; scopes: string[] }> = [{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }],
  run: (ctx: TestContext) => Promise<void>,
): Promise<void> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createConversationTables(db);
  createTasksTable(db);

  const convRepo = new SqliteConversationRepository(db);
  const taskRepo = new SqliteTaskRepository(db);

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
    await run({ base: `http://127.0.0.1:${address.port}/api/conversations`, db, server, convRepo, taskRepo });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    db.close();
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

async function createConversation(base: string, principalId = PRINCIPAL, title = 'Test Conversation') {
  const res = await fetch(base, {
    method: 'POST',
    headers: headers(TOKEN, principalId),
    body: JSON.stringify({ title }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

const TOKEN = 'test-conv-token';
const READ_ONLY_TOKEN = 'test-conv-readonly';
const PRINCIPAL = 'principal-alice';
const OTHER_PRINCIPAL = 'principal-bob';
const serial = { concurrency: false } as const;

test('conversation routes require bearer token', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, { headers: { 'x-principal-id': PRINCIPAL } });
    assert.equal(res.status, 401);
  });
});

test('conversation routes fail closed without configured credentials', serial, async () => {
  await withTestServer([], async ({ base }) => {
    const res = await fetch(base, { headers: { 'x-principal-id': PRINCIPAL } });
    assert.equal(res.status, 401);
  });
});

test('conversation routes require scope', serial, async () => {
  await withTestServer([{ token: READ_ONLY_TOKEN, scopes: ['conversations:read'] }], async ({ base }) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: headers(READ_ONLY_TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'Denied' }),
    });
    assert.equal(res.status, 403);
  });
});

test('conversation routes require X-Principal-Id', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 400);
  });
});

test('create conversation returns 201', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'Test Conversation' }),
    });
    assert.equal(res.status, 201);
    const conv = await res.json();
    assert.equal(conv.title, 'Test Conversation');
    assert.equal(conv.principalId, PRINCIPAL);
    assert.equal(conv.state, 'active');
    assert.equal(conv.revision, 1);
  });
});

test('create with Idempotency-Key returns same conversation', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const h = { ...headers(TOKEN, PRINCIPAL), 'idempotency-key': 'idem-123' };
    const res1 = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ title: 'First' }) });
    assert.equal(res1.status, 201);
    const conv1 = await res1.json();

    const res2 = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Second' }) });
    assert.equal(res2.status, 200);
    const conv2 = await res2.json();
    assert.equal(conv1.id, conv2.id);
    assert.equal(conv2.title, 'First');
  });
});

test('create rejects empty title', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: '' }),
    });
    assert.equal(res.status, 400);
  });
});

test('cross-principal getById returns 404', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base);
    const res = await fetch(`${base}/${conv.id}`, { headers: headers(TOKEN, OTHER_PRINCIPAL) });
    assert.equal(res.status, 404);
  });
});

test('cross-principal list returns empty', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    await createConversation(base);
    const res = await fetch(base, { headers: headers(TOKEN, OTHER_PRINCIPAL) });
    assert.equal(res.status, 200);
    const page = await res.json();
    assert.equal(page.conversations.length, 0);
  });
});

test('update requires If-Match', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Conv');
    const res = await fetch(`${base}/${conv.id}`, {
      method: 'PATCH',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ title: 'Updated' }),
    });
    assert.equal(res.status, 428);
  });
});

test('update with wrong revision returns 409', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Conv');
    const res = await fetch(`${base}/${conv.id}`, {
      method: 'PATCH',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': '999' },
      body: JSON.stringify({ title: 'Updated' }),
    });
    assert.equal(res.status, 409);
  });
});

test('update with correct revision succeeds and bumps revision', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Conv');
    const res = await fetch(`${base}/${conv.id}`, {
      method: 'PATCH',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(conv.revision) },
      body: JSON.stringify({ title: 'Updated Title' }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.title, 'Updated Title');
    assert.equal(updated.revision, conv.revision + 1);
  });
});

test('delete revokes claims and prevents further operations', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, convRepo }) => {
    const conv = await createConversation(base, PRINCIPAL, 'To Delete');
    const claimRes = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1 }),
    });
    assert.equal(claimRes.status, 200);

    const delRes = await fetch(`${base}/${conv.id}`, {
      method: 'DELETE',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(conv.revision) },
    });
    assert.equal(delRes.status, 204);

    assert.equal(await convRepo.getVoiceClaim(conv.id, PRINCIPAL), undefined);

    const getRes = await fetch(`${base}/${conv.id}`, { headers: headers(TOKEN, PRINCIPAL) });
    assert.equal(getRes.status, 404);

    const hydRes = await fetch(`${base}/${conv.id}/hydration`, { headers: headers(TOKEN, PRINCIPAL) });
    assert.equal(hydRes.status, 404);

    const appendRes = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello' }] }),
    });
    assert.equal(appendRes.status, 404);
  });
});

test('append messages assigns monotonic seqs', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Msg Conv');
    const appendRes = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: [
          { id: 'm1', role: 'user', kind: 'typed', text: 'Hello' },
          { id: 'm2', role: 'assistant', kind: 'speech_final', text: 'Hi there' },
        ],
      }),
    });
    assert.equal(appendRes.status, 200);
    const result = await appendRes.json();
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].seq, 1);
    assert.equal(result.messages[1].seq, 2);
    assert.equal(result.persistedThroughSeq, 2);
  });
});

test('clientEventId dedup returns existing message', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Dedup Conv');
    await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello', clientEventId: 'evt-1' }],
      }),
    });

    const res = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: [{ id: 'm2', role: 'user', kind: 'typed', text: 'Different text', clientEventId: 'evt-1' }],
      }),
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.messages[0].text, 'Hello');
    assert.equal(result.messages[0].seq, 1);
  });
});

test('messages afterSeq pagination', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Paged Conv');
    await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, role: 'user', kind: 'typed', text: `Message ${i}` })),
      }),
    });

    const res = await fetch(`${base}/${conv.id}/messages?afterSeq=2`, { headers: headers(TOKEN, PRINCIPAL) });
    assert.equal(res.status, 200);
    const page = await res.json();
    assert.equal(page.messages.length, 3);
    assert.equal(page.messages[0].seq, 3);
  });
});

test('stale epoch append is rejected after takeover', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Epoch Conv');

    const claimOne = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1 }),
    });
    assert.equal(claimOne.status, 200);

    const claimTwo = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 2 }),
    });
    assert.equal(claimTwo.status, 200);

    const appendRes = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello' }],
      }),
    });
    assert.equal(appendRes.status, 409);
    const err = await appendRes.json();
    assert.equal(err.error, 'stale epoch');
  });
});

test('archive revokes voice claims', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, convRepo }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Archive Conv');
    const claimRes = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1 }),
    });
    assert.equal(claimRes.status, 200);

    const archiveRes = await fetch(`${base}/${conv.id}`, {
      method: 'PATCH',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(conv.revision) },
      body: JSON.stringify({ state: 'archived' }),
    });
    assert.equal(archiveRes.status, 200);
    assert.equal(await convRepo.getVoiceClaim(conv.id, PRINCIPAL), undefined);
  });
});

test('hydration returns only summary tail messages', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, convRepo }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Hydration Conv');
    await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: [
          { id: 'm1', role: 'user', kind: 'typed', text: 'What is AI?' },
          { id: 'm2', role: 'assistant', kind: 'speech_final', text: 'AI is...' },
        ],
      }),
    });

    await convRepo.upsertSummary({
      conversationId: conv.id,
      version: 1,
      throughSeq: 1,
      text: 'User asked about AI',
      model: 'claude-3',
      policy: 'default',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const hydRes = await fetch(`${base}/${conv.id}/hydration`, { headers: headers(TOKEN, PRINCIPAL) });
    assert.equal(hydRes.status, 200);
    const hydration = await hydRes.json();
    assert.ok(hydration.summary);
    assert.equal(hydration.summary.throughSeq, 1);
    assert.equal(hydration.messages.length, 1);
    assert.equal(hydration.messages[0].seq, 2);
  });
});

test('provider session lifecycle', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, convRepo }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Provider Conv');
    const beginRes = await fetch(`${base}/${conv.id}/provider-sessions`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, provider: 'copilot', model: 'claude-opus-4' }),
    });
    assert.equal(beginRes.status, 201);
    const session = await beginRes.json();
    assert.equal(session.provider, 'copilot');
    assert.equal(session.epoch, 1);

    const finishRes = await fetch(`${base}/${conv.id}/provider-sessions/1/finish`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ endReason: 'user-ended' }),
    });
    assert.equal(finishRes.status, 200);

    const sessions = await convRepo.getProviderSessions(conv.id, PRINCIPAL);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].endReason, 'user-ended');
  });
});

test('task links are idempotent and tasks survive delete', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, taskRepo }) => {
    await taskRepo.create({
      id: 'task-1',
      projectId: 'default',
      title: 'Test Task',
      description: '',
      priority: 'medium',
      columnId: 'backlog',
      agentStatus: 'idle',
      agentType: 'copilot',
      createdAt: Date.now(),
    });

    const conv = await createConversation(base, PRINCIPAL, 'Link Conv');
    const linkRes = await fetch(`${base}/${conv.id}/tasks`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ taskId: 'task-1' }),
    });
    assert.equal(linkRes.status, 201);

    const linkRes2 = await fetch(`${base}/${conv.id}/tasks`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ taskId: 'task-1' }),
    });
    assert.equal(linkRes2.status, 200);

    const deleteRes = await fetch(`${base}/${conv.id}`, {
      method: 'DELETE',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(conv.revision) },
    });
    assert.equal(deleteRes.status, 204);

    const task = await taskRepo.getById('task-1');
    assert.ok(task);
    assert.equal(task.title, 'Test Task');
  });
});

test('voice claim acquire and release', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Claim Conv');
    const acqRes = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1 }),
    });
    assert.equal(acqRes.status, 200);
    const claim = await acqRes.json();
    assert.equal(claim.epoch, 1);

    const acqRes2 = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1 }),
    });
    assert.equal(acqRes2.status, 409);

    const relRes = await fetch(`${base}/${conv.id}/voice-claims/1`, {
      method: 'DELETE',
      headers: headers(TOKEN, PRINCIPAL),
    });
    assert.equal(relRes.status, 204);
  });
});

test('list conversations respects pagination and state filter', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const convs = [];
    for (let i = 0; i < 3; i += 1) {
      convs.push(await createConversation(base, PRINCIPAL, `Conv ${i}`));
    }
    const archiveRes = await fetch(`${base}/${convs[0].id}`, {
      method: 'PATCH',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(convs[0].revision) },
      body: JSON.stringify({ state: 'archived' }),
    });
    assert.equal(archiveRes.status, 200);

    const res = await fetch(`${base}?limit=2`, { headers: headers(TOKEN, PRINCIPAL) });
    const page = await res.json();
    assert.equal(page.conversations.length, 2);
    assert.equal(page.hasMore, true);
    assert.ok(page.cursor);

    const res2 = await fetch(`${base}?cursor=${page.cursor}`, { headers: headers(TOKEN, PRINCIPAL) });
    const page2 = await res2.json();
    assert.equal(page2.conversations.length, 1);
    assert.equal(page2.hasMore, false);

    const archivedRes = await fetch(`${base}?state=archived`, { headers: headers(TOKEN, PRINCIPAL) });
    const archivedPage = await archivedRes.json();
    assert.equal(archivedPage.conversations.length, 1);
    assert.equal(archivedPage.conversations[0].state, 'archived');
  });
});

test('conversation table creation is idempotent', serial, async () => {
  const db = new Database(':memory:');
  try {
    createConversationTables(db);
    createConversationTables(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'conversation%'").all() as { name: string }[];
    assert.ok(tables.length >= 5);
  } finally {
    db.close();
  }
});
