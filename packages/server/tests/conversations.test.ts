import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { SqliteConversationRepository } from '../src/repositories/sqlite-conversations.js';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import { createConversationsRouter } from '../src/routes/conversations.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { migrateSqliteDatabase } from '../src/db.js';

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
  // Use real migrations (not ad-hoc DDL)
  migrateSqliteDatabase(db);

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

async function acquireClaim(base: string, convId: string, epoch: number, principalId = PRINCIPAL) {
  const res = await fetch(`${base}/${convId}/voice-claims`, {
    method: 'POST',
    headers: headers(TOKEN, principalId),
    body: JSON.stringify({ epoch }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

const TOKEN = 'test-conv-token';
const READ_ONLY_TOKEN = 'test-conv-readonly';
const PRINCIPAL = 'principal-alice';
const OTHER_PRINCIPAL = 'principal-bob';
const serial = { concurrency: false } as const;

// ─── Auth tests ───────────────────────────────────────────────────────────────

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

// ─── Create tests ─────────────────────────────────────────────────────────────

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

    const res2 = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ title: 'First' }) });
    assert.equal(res2.status, 200);
    const conv2 = await res2.json();
    assert.equal(conv1.id, conv2.id);
    assert.equal(conv2.title, 'First');
  });
});

test('create with Idempotency-Key and changed payload returns 409', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const h = { ...headers(TOKEN, PRINCIPAL), 'idempotency-key': 'idem-conflict' };
    const res1 = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Original' }) });
    assert.equal(res1.status, 201);

    const res2 = await fetch(base, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Different' }) });
    assert.equal(res2.status, 409);
    const body = await res2.json();
    assert.equal(body.error, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
  });
});

test('idempotency key is principal-scoped', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const h1 = { ...headers(TOKEN, PRINCIPAL), 'idempotency-key': 'shared-key' };
    const h2 = { ...headers(TOKEN, OTHER_PRINCIPAL), 'idempotency-key': 'shared-key' };

    const res1 = await fetch(base, { method: 'POST', headers: h1, body: JSON.stringify({ title: 'Alice Conv' }) });
    assert.equal(res1.status, 201);
    const conv1 = await res1.json();

    const res2 = await fetch(base, { method: 'POST', headers: h2, body: JSON.stringify({ title: 'Bob Conv' }) });
    assert.equal(res2.status, 201);
    const conv2 = await res2.json();

    assert.notEqual(conv1.id, conv2.id);
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

// ─── Principal isolation ──────────────────────────────────────────────────────

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

// ─── PATCH tests ──────────────────────────────────────────────────────────────

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

test('PATCH rejects unknown fields', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Conv');
    const res = await fetch(`${base}/${conv.id}`, {
      method: 'PATCH',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(conv.revision) },
      body: JSON.stringify({ title: 'Valid', unknownField: true }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'UNKNOWN_FIELDS');
  });
});

test('PATCH enforces explicit state transitions', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Conv');
    // active -> archived is valid
    const res1 = await fetch(`${base}/${conv.id}`, {
      method: 'PATCH',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(conv.revision) },
      body: JSON.stringify({ state: 'archived' }),
    });
    assert.equal(res1.status, 200);
    const archived = await res1.json();
    assert.equal(archived.state, 'archived');

    // archived -> active (unarchive) is valid
    const res2 = await fetch(`${base}/${conv.id}`, {
      method: 'PATCH',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(archived.revision) },
      body: JSON.stringify({ state: 'active' }),
    });
    assert.equal(res2.status, 200);
  });
});

// ─── DELETE tests ─────────────────────────────────────────────────────────────

test('delete revokes claims and prevents further operations', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, convRepo }) => {
    const conv = await createConversation(base, PRINCIPAL, 'To Delete');
    await acquireClaim(base, conv.id, 1);

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
  });
});

test('delete with wrong revision returns 409', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Conv');
    const res = await fetch(`${base}/${conv.id}`, {
      method: 'DELETE',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': '999' },
    });
    assert.equal(res.status, 409);
  });
});

test('delete cross-principal returns 404', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Conv');
    const res = await fetch(`${base}/${conv.id}`, {
      method: 'DELETE',
      headers: { ...headers(TOKEN, OTHER_PRINCIPAL), 'if-match': String(conv.revision) },
    });
    assert.equal(res.status, 404);
  });
});

// ─── Append tests ─────────────────────────────────────────────────────────────

test('append messages requires voice claim', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'No Claim Conv');
    const appendRes = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello' }],
      }),
    });
    assert.equal(appendRes.status, 409);
    const body = await appendRes.json();
    assert.equal(body.error, 'NO_VOICE_CLAIM');
  });
});

test('append messages assigns monotonic seqs', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Msg Conv');
    await acquireClaim(base, conv.id, 1);

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

test('append via messages:append route works', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Append Route Conv');
    await acquireClaim(base, conv.id, 1);

    const appendRes = await fetch(`${base}/${conv.id}/messages:append`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello' }],
      }),
    });
    assert.equal(appendRes.status, 200);
  });
});

test('clientEventId dedup returns existing message on exact match', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Dedup Conv');
    await acquireClaim(base, conv.id, 1);

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
        messages: [{ id: 'm2', role: 'user', kind: 'typed', text: 'Hello', clientEventId: 'evt-1' }],
      }),
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.messages[0].text, 'Hello');
    assert.equal(result.messages[0].seq, 1);
  });
});

test('clientEventId replay with changed payload returns 409', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Conflict Conv');
    await acquireClaim(base, conv.id, 1);

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
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'CLIENT_EVENT_CONFLICT');
  });
});

test('append rejects epoch 0', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Epoch0 Conv');
    const res = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 0,
        messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello' }],
      }),
    });
    assert.equal(res.status, 400);
  });
});

test('expired claim rejects append', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, db }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Expired Conv');
    await acquireClaim(base, conv.id, 1);

    // Manually expire the claim
    db.prepare('UPDATE conversation_voice_claims SET expires_at = ? WHERE conversation_id = ?')
      .run(Date.now() - 1000, conv.id);

    const res = await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'Hello' }],
      }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'CLAIM_EXPIRED');
  });
});

// ─── Voice claim tests ────────────────────────────────────────────────────────

test('stale epoch append is rejected after takeover', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Epoch Conv');
    await acquireClaim(base, conv.id, 1);
    await acquireClaim(base, conv.id, 2);

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
    assert.equal(err.error, 'STALE_EPOCH');
  });
});

test('epoch must be strictly monotonically increasing', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Monotonic Conv');
    await acquireClaim(base, conv.id, 5);

    // Same epoch should fail
    const res1 = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 5 }),
    });
    assert.equal(res1.status, 409);

    // Lower epoch should fail
    const res2 = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 3 }),
    });
    assert.equal(res2.status, 409);

    // Higher epoch succeeds
    const res3 = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 6 }),
    });
    assert.equal(res3.status, 200);
  });
});

test('epoch fence persists after release', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Fence Conv');
    await acquireClaim(base, conv.id, 5);

    // Release the claim
    const relRes = await fetch(`${base}/${conv.id}/voice-claims/5`, {
      method: 'DELETE',
      headers: headers(TOKEN, PRINCIPAL),
    });
    assert.equal(relRes.status, 204);

    // Cannot reuse epoch 5 or lower
    const res = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 5 }),
    });
    assert.equal(res.status, 409);

    // Can use epoch 6
    const res2 = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 6 }),
    });
    assert.equal(res2.status, 200);
  });
});

test('archive revokes voice claims', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, convRepo }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Archive Conv');
    await acquireClaim(base, conv.id, 1);

    const archiveRes = await fetch(`${base}/${conv.id}`, {
      method: 'PATCH',
      headers: { ...headers(TOKEN, PRINCIPAL), 'if-match': String(conv.revision) },
      body: JSON.stringify({ state: 'archived' }),
    });
    assert.equal(archiveRes.status, 200);
    assert.equal(await convRepo.getVoiceClaim(conv.id, PRINCIPAL), undefined);
  });
});

test('voice claim TTL is bounded by server policy', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'TTL Conv');

    // Request TTL exceeding max should be rejected at route level
    const res = await fetch(`${base}/${conv.id}/voice-claims`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, ttlMs: 999999999 }),
    });
    assert.equal(res.status, 400);
  });
});

// ─── Messages pagination ──────────────────────────────────────────────────────

test('messages afterSeq pagination', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Paged Conv');
    await acquireClaim(base, conv.id, 1);
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

// ─── Hydration tests ──────────────────────────────────────────────────────────

test('hydration returns bounded summary tail messages', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, convRepo, db }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Hydration Conv');
    await acquireClaim(base, conv.id, 1);
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

    // Directly insert summary (bypass claim check for test setup)
    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, version, through_seq, text, model, policy, created_at, updated_at)
      VALUES (?, 1, 1, 'User asked about AI', 'claude-3', 'default', ?, ?)
    `).run(conv.id, Date.now(), Date.now());

    const hydRes = await fetch(`${base}/${conv.id}/hydration`, { headers: headers(TOKEN, PRINCIPAL) });
    assert.equal(hydRes.status, 200);
    const hydration = await hydRes.json();
    assert.ok(hydration.summary);
    assert.equal(hydration.summary.throughSeq, 1);
    assert.equal(hydration.messages.length, 1);
    assert.equal(hydration.messages[0].seq, 2);
  });
});

test('hydration respects max turns and char limits', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Bounded Hydration');
    await acquireClaim(base, conv.id, 1);

    // Insert 30 messages (exceeds MAX_HYDRATION_TURNS=24)
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      kind: 'typed',
      text: `Message ${i}`,
    }));
    await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, messages: msgs }),
    });

    const hydRes = await fetch(`${base}/${conv.id}/hydration`, { headers: headers(TOKEN, PRINCIPAL) });
    assert.equal(hydRes.status, 200);
    const hydration = await hydRes.json();
    assert.ok(hydration.messages.length <= 24);
  });
});

// ─── Provider session tests ───────────────────────────────────────────────────

test('provider session requires active claim', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Provider Conv');
    // No claim acquired
    const res = await fetch(`${base}/${conv.id}/provider-sessions`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, provider: 'copilot', model: 'claude-opus-4' }),
    });
    assert.equal(res.status, 409);
  });
});

test('provider session lifecycle with claim', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base, convRepo }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Provider Conv');
    await acquireClaim(base, conv.id, 1);

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

test('provider session validates field lengths', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Validation Conv');
    await acquireClaim(base, conv.id, 1);

    const res = await fetch(`${base}/${conv.id}/provider-sessions`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({ epoch: 1, provider: 'x'.repeat(100) }),
    });
    assert.equal(res.status, 400);
  });
});

// ─── Task links ───────────────────────────────────────────────────────────────

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

// ─── Search tests ─────────────────────────────────────────────────────────────

test('search finds conversations by title', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    await createConversation(base, PRINCIPAL, 'Alpha Project');
    await createConversation(base, PRINCIPAL, 'Beta Discussion');

    const res = await fetch(`${base}/search?q=Alpha`, { headers: headers(TOKEN, PRINCIPAL) });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.conversations.length, 1);
    assert.equal(result.conversations[0].title, 'Alpha Project');
  });
});

test('search finds conversations by message text', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    const conv = await createConversation(base, PRINCIPAL, 'Generic Title');
    await acquireClaim(base, conv.id, 1);
    await fetch(`${base}/${conv.id}/messages`, {
      method: 'POST',
      headers: headers(TOKEN, PRINCIPAL),
      body: JSON.stringify({
        epoch: 1,
        messages: [{ id: 'm1', role: 'user', kind: 'typed', text: 'unique-search-term' }],
      }),
    });

    const res = await fetch(`${base}/search?q=unique-search-term`, { headers: headers(TOKEN, PRINCIPAL) });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.conversations.length, 1);
  });
});

test('search is principal-scoped', serial, async () => {
  await withTestServer([{ token: TOKEN, scopes: ['conversations:read', 'conversations:write'] }], async ({ base }) => {
    await createConversation(base, PRINCIPAL, 'Secret Conversation');

    const res = await fetch(`${base}/search?q=Secret`, { headers: headers(TOKEN, OTHER_PRINCIPAL) });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.conversations.length, 0);
  });
});

// ─── List pagination ──────────────────────────────────────────────────────────

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

// ─── Migration idempotency ────────────────────────────────────────────────────

test('migration is idempotent on SQLite', serial, async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    migrateSqliteDatabase(db);
    migrateSqliteDatabase(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'conversation%'").all() as { name: string }[];
    assert.ok(tables.length >= 6); // conversations, messages, summaries, provider_sessions, task_links, voice_claims, epoch_fences
  } finally {
    db.close();
  }
});

test('idempotency index is principal-scoped', serial, async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    migrateSqliteDatabase(db);
    const indices = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_conversations_idempotency'").all() as { sql: string }[];
    assert.ok(indices.length > 0);
    assert.ok(indices[0].sql.includes('principal_id'));
  } finally {
    db.close();
  }
});
