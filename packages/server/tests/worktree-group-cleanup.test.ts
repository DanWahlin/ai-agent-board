import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import type { Task, TaskGroup } from '../src/types.js';
import type { TaskGroupRepository } from '../src/repositories/group-types.js';
import type { TaskRepository } from '../src/repositories/types.js';
import type { ProjectRepository } from '../src/repositories/project-types.js';
import type { AgentManager } from '../src/services/agent-manager.js';
import { createGroupsRouter } from '../src/routes/groups.js';

const group: TaskGroup = {
  id: 'group-1',
  title: 'Cleanup group',
  priority: 'medium',
  columnId: 'review',
  maxConcurrency: 1,
  createdAt: 1,
  projectId: 'project-1',
};

function child(id: string): Task {
  return {
    id,
    title: id,
    description: '',
    priority: 'medium',
    columnId: 'review',
    agentStatus: 'complete',
    createdAt: 1,
    projectId: 'project-1',
    repoPath: '/repo',
    branchName: `agent/${id}`,
    baseBranch: 'main',
    useWorktree: true,
    worktreePath: `/tmp/agentboard-${id}-ABC123`,
    groupId: group.id,
  };
}

test('group delete persists earlier cleanup if a later worktree changes after preflight', async () => {
  const children = [child('11111111-1111-4111-8111-111111111111'), child('22222222-2222-4222-8222-222222222222')];
  let deleted = false;
  const groupRepo = {
    getById: async () => group,
    getChildTasks: async () => children,
    delete: async () => { deleted = true; return true; },
  } as unknown as TaskGroupRepository;
  const taskRepo = {
    update: async (id: string, updates: Partial<Task>) => {
      const task = children.find((candidate) => candidate.id === id);
      if (!task) return undefined;
      Object.assign(task, updates);
      return task;
    },
  } as unknown as TaskRepository;
  let removals = 0;
  const agentManager = {
    stopGroup: async () => {},
    inspectWorktree: () => ({ status: 'ready', device: 1, inode: 1 }),
    removeWorktree: () => ++removals === 1
      ? ({ status: 'removed' } as const)
      : ({ status: 'blocked', reason: 'changed after preflight' } as const),
  } as unknown as AgentManager;
  const projectRepo = {} as ProjectRepository;

  const app = express();
  app.use(express.json());
  app.use('/api/groups', createGroupsRouter(groupRepo, taskRepo, agentManager, projectRepo));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/groups/${group.id}`, { method: 'DELETE' });
    assert.equal(response.status, 409);
    assert.equal(deleted, false);
    assert.equal(children[0]?.worktreePath, undefined);
    assert.equal(children[1]?.worktreePath?.includes(children[1]!.id), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
