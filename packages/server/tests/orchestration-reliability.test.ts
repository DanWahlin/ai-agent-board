import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteTaskRepository } from '../src/repositories/sqlite.js';
import type { Task } from '../src/types.js';

function repo() {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, priority TEXT, column_id TEXT, agent_status TEXT, agent_type TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, repo_path TEXT, branch_name TEXT, base_branch TEXT, use_worktree INTEGER, worktree_path TEXT, archived INTEGER, group_id TEXT, group_order INTEGER, summary TEXT, external_source TEXT, external_key TEXT, provenance TEXT, run_requested_at INTEGER, run_claimed_at INTEGER); CREATE UNIQUE INDEX identity ON tasks(external_source,external_key) WHERE external_source IS NOT NULL AND external_key IS NOT NULL; CREATE TABLE events(id TEXT,task_id TEXT,type TEXT,content TEXT,timestamp INTEGER,metadata TEXT);`);
  return {db,repo:new SqliteTaskRepository(db)};
}
const task=(id:string):Task=>({id,projectId:'default',title:'x',description:'',priority:'medium',columnId:'in-progress',agentStatus:'idle',agentType:'hermes',createdAt:1,externalSource:'test',externalKey:'same'});

test('idempotent create atomically returns original task', async()=>{ const {db,repo:r}=repo(); try { assert.equal((await r.createIdempotent(task('one'))).created,true); const replay=await r.createIdempotent(task('two')); assert.equal(replay.created,false); assert.equal(replay.task.id,'one'); assert.equal(await r.count(),1); } finally {db.close();} });
test('run claim is leased, compare-and-set, and stale claims recover', async()=>{ const {db,repo:r}=repo(); try {await r.create(task('one')); await r.requestRun('one',10); assert.equal((await r.getPendingRuns(10)).length,1); assert.ok(await r.claimRun('one',11)); assert.equal(await r.claimRun('one',12),undefined); assert.equal((await r.getPendingRuns(0)).length,0); assert.equal((await r.getPendingRuns(50_012)).length,1); assert.ok(await r.claimRun('one',50_012)); await r.clearRun('one'); assert.equal((await r.getPendingRuns(100_000)).length,0);} finally{db.close();} });
