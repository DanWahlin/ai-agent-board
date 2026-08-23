import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initPostgresDatabase, migrateSqliteDatabase } from '../src/db.js';

test('SQLite migration backfills legacy external tasks idempotently with safe deterministic snapshots', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrateSqliteDatabase(db);
    const insert = db.prepare(`INSERT INTO tasks
      (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at,
       external_source, external_key, run_requested_at, timeout_minutes)
      VALUES (?, 'default', ?, ?, 'medium', 'backlog', 'idle', 'hermes', ?, ?, ?, ?, ?)`);
    insert.run('legacy/one "quoted"', 'Legacy "one"', 'line\ntext', 11, 'hermes', 'old-key-1', null, null);
    insert.run('legacy-two', 'Legacy two', '', 12, 'other', 'old-key-2', 99, 45);
    db.prepare(`INSERT INTO tasks
      (id, project_id, title, description, priority, column_id, agent_status, agent_type, created_at)
      VALUES ('ordinary', 'default', 'Ordinary', '', 'medium', 'backlog', 'idle', 'hermes', 13)`).run();

    migrateSqliteDatabase(db);
    const first = db.prepare('SELECT * FROM execution_attempts ORDER BY task_id').all() as Array<Record<string, unknown>>;
    migrateSqliteDatabase(db);
    const second = db.prepare('SELECT * FROM execution_attempts ORDER BY task_id').all() as Array<Record<string, unknown>>;

    assert.deepEqual(second, first);
    assert.equal(first.length, 2);
    for (const row of first) {
      assert.match(String(row.id), /^legacy-task-[0-9a-f]+$/);
      const snapshot = JSON.parse(String(row.request_snapshot));
      assert.equal(snapshot.kind, 'legacy-task-backfill');
      assert.equal(snapshot.taskId, row.task_id);
      assert.equal(snapshot.externalSource, row.external_source);
      assert.equal(snapshot.externalKey, row.external_key);
    }
    const pending = first.find((row) => row.task_id === 'legacy/one "quoted"');
    const dispatched = first.find((row) => row.task_id === 'legacy-two');
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.auto_start, 0);
    assert.equal(dispatched?.status, 'dispatched');
    assert.equal(dispatched?.auto_start, 1);
  } finally {
    db.close();
  }
});

test('PostgreSQL migration uses an idempotent deterministic execution-attempt backfill', async () => {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };
  await initPostgresDatabase(pool as never);
  const backfill = calls.find((sql) => sql.includes("'legacy-task-' || encode(convert_to(t.id"));
  assert.ok(backfill);
  assert.match(backfill, /WHERE t\.external_source IS NOT NULL AND t\.external_key IS NOT NULL/);
  assert.match(backfill, /ON CONFLICT \(external_source, external_key\) DO NOTHING/);
  assert.match(backfill, /json_build_object/);
  assert.match(backfill, /CASE WHEN t\.run_requested_at IS NOT NULL THEN 'dispatched' ELSE 'pending' END/);
});
