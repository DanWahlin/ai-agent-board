import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import type { Task } from '../src/types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import { createTaskRouter } from '../src/routes/tasks.js';
import { createGitRouter } from '../src/routes/git.js';

const baseTask: Task = {
  id: 'task-1',
  title: 'Lifecycle task',
  description: '',
  priority: 'medium',
  columnId: 'review',
  agentStatus: 'failed',
  createdAt: 1,
  projectId: 'project-1',
  repoPath: '/repo',
  branchName: 'agent/task-1',
  baseBranch: 'main',
  useWorktree: true,
  worktreePath: '/tmp/agentboard-task-1-fixture',
};

async function withRoutes(
  cleanup: { status: 'removed' | 'missing' } | { status: 'blocked'; reason: string },
  run: (baseUrl: string, state: { task: Task | undefined; deleted: boolean }) => Promise<void>,
): Promise<void> {
  const state = { task: { ...baseTask } as Task | undefined, deleted: false };
  const repo = {
    getById: async () => state.task,
    update: async (_id: string, updates: Partial<Task>) => {
      if (!state.task) return undefined;
      state.task = { ...state.task, ...updates };
      return state.task;
    },
    deleteEventsByTaskId: async () => {},
    delete: async () => { state.deleted = true; state.task = undefined; return true; },
  } as unknown as TaskRepository;
  const projectRepo = {
    getById: async () => ({ id: 'project-1', name: 'Project', isDefault: false, createdAt: 1, updatedAt: 1 }),
  } as unknown as ProjectRepository;
  const manager = {
    isRunning: () => false,
    removeWorktree: () => cleanup,
    clearEvents: () => {},
  } as unknown as AgentManager;

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createTaskRouter(repo, manager, projectRepo));
  app.use('/api/tasks', createGitRouter(repo, manager));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  try {
    await run(`http://127.0.0.1:${address.port}`, state);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('moving a card to Done removes a clean worktree and clears its persisted path', async () => {
  await withRoutes({ status: 'removed' }, async (baseUrl, state) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ columnId: 'done' }),
    });
    assert.equal(response.status, 200);
    assert.equal(state.task?.columnId, 'done');
    assert.equal(state.task?.worktreePath, undefined);
  });
});

test('dirty cleanup allows Done and archive but retains recovery state', async () => {
  await withRoutes({ status: 'blocked', reason: 'Worktree has uncommitted or untracked changes.' }, async (baseUrl, state) => {
    const done = await fetch(`${baseUrl}/api/tasks/task-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ columnId: 'done' }),
    });
    assert.equal(done.status, 200);
    assert.equal(state.task?.columnId, 'done');
    assert.equal(state.task?.worktreePath, baseTask.worktreePath);

    const archive = await fetch(`${baseUrl}/api/tasks/task-1/archive`, { method: 'PATCH' });
    assert.equal(archive.status, 200);
    assert.equal(state.task?.archived, true);
    assert.equal(state.task?.worktreePath, baseTask.worktreePath);
  });
});

test('dirty cleanup blocks delete and manual cleanup without losing task state', async () => {
  await withRoutes({ status: 'blocked', reason: 'Worktree has uncommitted or untracked changes.' }, async (baseUrl, state) => {
    for (const url of [
      `${baseUrl}/api/tasks/task-1`,
      `${baseUrl}/api/tasks/task-1/cleanup-worktree`,
    ]) {
      const response = await fetch(url, { method: url.endsWith('cleanup-worktree') ? 'POST' : 'DELETE' });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /uncommitted|cleanup blocked/i);
    }
    assert.equal(state.deleted, false);
    assert.equal(state.task?.columnId, 'review');
    assert.equal(state.task?.worktreePath, baseTask.worktreePath);
  });
});

test('archive, delete, and manual cleanup clear clean worktree state', async () => {
  await withRoutes({ status: 'removed' }, async (baseUrl, state) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/archive`, { method: 'PATCH' });
    assert.equal(response.status, 200);
    assert.equal(state.task?.archived, true);
    assert.equal(state.task?.worktreePath, undefined);
  });
  await withRoutes({ status: 'removed' }, async (baseUrl, state) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/cleanup-worktree`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(state.task?.worktreePath, undefined);
  });
  await withRoutes({ status: 'removed' }, async (baseUrl, state) => {
    const response = await fetch(`${baseUrl}/api/tasks/task-1`, { method: 'DELETE' });
    assert.equal(response.status, 204);
    assert.equal(state.deleted, true);
  });
});
