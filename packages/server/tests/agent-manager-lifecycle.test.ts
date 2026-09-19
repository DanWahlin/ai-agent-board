import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '../../../shared/types.js';
import { AgentManager, hermesCommandForExecution, usesTaskScopedHermesProvider } from '../src/services/agent-manager.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function task(id: string): Task {
  return {
    id,
    title: 'Lifecycle test',
    description: 'Exercise lifecycle ordering.',
    priority: 'medium',
    columnId: 'in-progress',
    agentStatus: 'planning',
    createdAt: Date.now(),
    projectId: 'project-test',
    agentType: 'copilot',
  };
}

function managerWithSession(session: Record<string, unknown>): AgentManager {
  const manager = new AgentManager();
  const internals = manager as unknown as {
    providers: Map<string, unknown>;
    availableAgents: Array<{ name: string; displayName: string; available: boolean }>;
  };
  internals.providers.set('copilot', {
    displayName: 'Fake Copilot',
    start: async () => {},
    stop: async () => {},
    createSession: async () => session,
  });
  internals.availableAgents = [{ name: 'copilot', displayName: 'Fake Copilot', available: true }];
  return manager;
}

test('terminal cleanup releases the run when event counting fails', async () => {
  const statuses: string[] = [];
  const manager = managerWithSession({
    execute: async () => ({ status: 'complete' }),
    abort: async () => {},
    destroy: async () => {},
    send: async () => {},
  });
  manager.getEvents = async () => { throw new Error('event store unavailable'); };

  assert.equal(manager.startAgent(task('terminal-cleanup'), async (status) => { statuses.push(status); }), true);
  await waitFor(() => statuses.includes('complete'), 'terminal status was not persisted');

  assert.equal(manager.isRunning('terminal-cleanup'), false);
  assert.equal(manager.startAgent(task('terminal-cleanup'), async () => {}), true);
});

test('a stop during attachment loading prevents stale execution', async () => {
  const attachmentsRequested = deferred<void>();
  const attachments = deferred<never[]>();
  let executeCount = 0;
  const manager = managerWithSession({
    execute: async () => { executeCount += 1; return { status: 'complete' }; },
    abort: async () => {},
    destroy: async () => {},
    send: async () => {},
  });
  manager.initAttachmentStore({
    getByTaskId: async () => {
      attachmentsRequested.resolve();
      return attachments.promise;
    },
  } as never);

  assert.equal(manager.startAgent(task('attachment-stop'), async () => {}), true);
  await attachmentsRequested.promise;
  const stopped = manager.stopAgent('attachment-stop');
  attachments.resolve([]);
  assert.equal(await stopped, true);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(executeCount, 0);
  assert.equal(manager.isRunning('attachment-stop'), false);
});

test('a completed run stays claimed until result persistence and terminal status finish', async () => {
  const persistenceStarted = deferred<void>();
  const persistenceGate = deferred<void>();
  const statuses: string[] = [];
  const manager = managerWithSession({
    execute: async () => ({ status: 'complete' }),
    abort: async () => {},
    destroy: async () => {},
    send: async () => {},
  });
  manager.initEventPersistence({
    update: async () => {
      persistenceStarted.resolve();
      await persistenceGate.promise;
      return task('result-persistence');
    },
    insertEvent: async () => {},
    getEventsByTaskId: async () => [],
  } as never);

  assert.equal(manager.startAgent(task('result-persistence'), async (status) => { statuses.push(status); }), true);
  await persistenceStarted.promise;
  assert.equal(manager.isRunning('result-persistence'), true);
  assert.equal(manager.startAgent(task('result-persistence'), async () => {}), false);

  persistenceGate.resolve();
  await waitFor(() => statuses.includes('complete'), 'completion did not finish after persistence');
  assert.equal(manager.isRunning('result-persistence'), false);
});

test('stop keeps result persistence fenced before admitting a successor', async () => {
  const persistenceStarted = deferred<void>();
  const persistenceGate = deferred<void>();
  let stopFinished = false;
  const manager = managerWithSession({
    execute: async () => ({ status: 'complete' }),
    abort: async () => {},
    destroy: async () => {},
    send: async () => {},
  });
  manager.initEventPersistence({
    update: async () => {
      persistenceStarted.resolve();
      await persistenceGate.promise;
      return task('stop-persistence');
    },
    insertEvent: async () => {},
    getEventsByTaskId: async () => [],
  } as never);

  assert.equal(manager.startAgent(task('stop-persistence'), async () => {}), true);
  await persistenceStarted.promise;
  const stopping = manager.stopAgent('stop-persistence').then((value) => { stopFinished = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(stopFinished, false);
  assert.equal(manager.isRunning('stop-persistence'), true);
  assert.equal(manager.startAgent(task('stop-persistence'), async () => {}), false);

  persistenceGate.resolve();
  assert.equal(await stopping, true);
  assert.equal(manager.isRunning('stop-persistence'), false);
});

test('timeout keeps the task busy until old execution teardown settles', async () => {
  const oldTimeout = process.env.AGENT_TIMEOUT_MS;
  process.env.AGENT_TIMEOUT_MS = '20';
  const executeResult = deferred<{ status: 'complete' }>();
  const abortGate = deferred<void>();
  const destroyGate = deferred<void>();
  const statuses: string[] = [];
  const manager = managerWithSession({
    execute: async () => executeResult.promise,
    abort: async () => abortGate.promise,
    destroy: async () => destroyGate.promise,
    send: async () => {},
  });

  try {
    assert.equal(manager.startAgent(task('timeout-teardown'), async (status) => { statuses.push(status); }), true);
    await waitFor(() => statuses.includes('executing'), 'session never entered executing');
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(manager.isRunning('timeout-teardown'), true);
    assert.equal(manager.startAgent(task('timeout-teardown'), async () => {}), false);

    abortGate.resolve();
    destroyGate.resolve();
    await waitFor(() => statuses.includes('failed'), 'timeout terminal status did not persist');
    assert.equal(manager.isRunning('timeout-teardown'), false);
    executeResult.resolve({ status: 'complete' });
  } finally {
    if (oldTimeout === undefined) delete process.env.AGENT_TIMEOUT_MS;
    else process.env.AGENT_TIMEOUT_MS = oldTimeout;
  }
});

test('synchronous timeout teardown errors cannot wedge admission', async () => {
  const oldTimeout = process.env.AGENT_TIMEOUT_MS;
  process.env.AGENT_TIMEOUT_MS = '20';
  const statuses: string[] = [];
  const manager = managerWithSession({
    execute: async () => new Promise(() => {}),
    abort: () => { throw new Error('synchronous abort failure'); },
    destroy: () => { throw new Error('synchronous destroy failure'); },
    send: async () => {},
  });

  try {
    assert.equal(manager.startAgent(task('timeout-sync-throw'), async (status) => { statuses.push(status); }), true);
    await waitFor(() => statuses.includes('failed'), 'timeout did not survive synchronous teardown errors');
    assert.equal(manager.isRunning('timeout-sync-throw'), false);
  } finally {
    if (oldTimeout === undefined) delete process.env.AGENT_TIMEOUT_MS;
    else process.env.AGENT_TIMEOUT_MS = oldTimeout;
  }
});

test('shutdown rejects new sessions after teardown begins', async () => {
  const manager = managerWithSession({
    execute: async () => ({ status: 'complete' }),
    abort: async () => {},
    destroy: async () => {},
    send: async () => {},
  });
  const shutdown = manager.shutdownAll();
  assert.equal(manager.startAgent(task('after-shutdown'), async () => {}), false);
  await shutdown;
});

test('shutdown waits for an already-running stop cleanup', async () => {
  const executeResult = deferred<{ status: 'complete' }>();
  const abortGate = deferred<void>();
  let executing = false;
  let shutdownFinished = false;
  const manager = managerWithSession({
    execute: async () => executeResult.promise,
    abort: async () => abortGate.promise,
    destroy: async () => {},
    send: async () => {},
  });

  assert.equal(manager.startAgent(task('shutdown-during-stop'), async (status) => { if (status === 'executing') executing = true; }), true);
  await waitFor(() => executing, 'session never entered executing');
  const stopping = manager.stopAgent('shutdown-during-stop');
  const shutdown = manager.shutdownAll().then(() => { shutdownFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(shutdownFinished, false);

  abortGate.resolve();
  executeResult.resolve({ status: 'complete' });
  assert.equal(await stopping, true);
  await shutdown;
  assert.equal(shutdownFinished, true);
});

test('shutdown promise remains pending until task cleanup settles', async () => {
  const stopGate = deferred<void>();
  let finished = false;
  const manager = new AgentManager();
  const runToken = Symbol('shutdown-wait');
  const internals = manager as unknown as {
    sessions: Map<string, unknown>;
    latestRunTokens: Map<string, symbol>;
  };
  internals.sessions.set('shutdown-wait', {
    runToken,
    startTime: Date.now(),
    agentType: 'hermes',
    taskScopedProvider: { stop: async () => stopGate.promise },
    session: { abort: async () => {}, destroy: async () => {} },
  });
  internals.latestRunTokens.set('shutdown-wait', runToken);

  const shutdown = manager.shutdownAll().then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(finished, false);
  stopGate.resolve();
  await shutdown;
  assert.equal(finished, true);
});

test('shutdown stops task-scoped providers before session teardown', async () => {
  const calls: string[] = [];
  const manager = new AgentManager();
  const runToken = Symbol('shutdown');
  const internals = manager as unknown as {
    sessions: Map<string, unknown>;
    latestRunTokens: Map<string, symbol>;
  };
  internals.sessions.set('shutdown', {
    runToken,
    startTime: Date.now(),
    agentType: 'hermes',
    taskScopedProvider: { stop: async () => { calls.push('provider'); } },
    session: {
      abort: async () => { calls.push('abort'); },
      destroy: async () => { calls.push('destroy'); },
    },
  });
  internals.latestRunTokens.set('shutdown', runToken);

  const shutdown = manager.shutdownAll();
  await waitFor(() => calls.length === 3, 'shutdown cleanup did not finish');
  await shutdown;
  assert.deepEqual(calls, ['provider', 'abort', 'destroy']);
  assert.equal(manager.isRunning('shutdown'), false);
});

test('termination is reported busy until stop cleanup finishes', async () => {
  const executeResult = deferred<{ status: 'complete' }>();
  const abortGate = deferred<void>();
  let executing = false;
  const manager = managerWithSession({
    execute: async () => executeResult.promise,
    abort: async () => abortGate.promise,
    destroy: async () => {},
    send: async () => {},
  });

  assert.equal(manager.startAgent(task('busy-stop'), async (status) => { if (status === 'executing') executing = true; }), true);
  await waitFor(() => executing, 'session never entered executing');
  const stopping = manager.stopAgent('busy-stop');
  await waitFor(() => manager.isRunning('busy-stop'), 'terminating state was not visible');

  assert.equal(manager.startAgent(task('busy-stop'), async () => {}), false);
  abortGate.resolve();
  assert.equal(await stopping, true);
  assert.equal(manager.isRunning('busy-stop'), false);
  executeResult.resolve({ status: 'complete' });
});

test('agent-default executes private input byte-for-byte without coding prompt or repo scope', async () => {
  let options: Record<string, unknown> | undefined;
  let prompt: string | undefined;
  const statuses: string[] = [];
  const manager = managerWithSession({
    execute: async (value: string) => { prompt = value; return { status: 'complete' }; },
    abort: async () => {}, destroy: async () => {}, send: async () => {},
  });
  const internals = manager as unknown as { providers: Map<string, { createSession: (value: Record<string, unknown>) => Promise<unknown> }> };
  const provider = internals.providers.get('copilot')!;
  const original = provider.createSession;
  provider.createSession = async (value) => { options = value; return original(value); };
  const input = '  exact\n<input> with trailing spaces  ';
  assert.equal(manager.startAgent({ ...task('agent-default'), repoPath: '/should/not/scope', useWorktree: true },
    async (status) => { statuses.push(status); }, undefined,
    { attemptId: 'attempt-1', orchestrationMode: 'agent-default', executionInput: input }), true);
  await waitFor(() => statuses.includes('complete'), 'agent-default run did not complete');
  assert.equal(prompt, input);
  assert.equal(options?.systemPrompt, '');
  assert.equal(options?.repoPath, undefined);
});

test('coding execution retains its coding prompt contract', async () => {
  let options: Record<string, unknown> | undefined;
  let prompt: string | undefined;
  const statuses: string[] = [];
  const manager = managerWithSession({
    execute: async (value: string) => { prompt = value; return { status: 'complete' }; },
    abort: async () => {}, destroy: async () => {}, send: async () => {},
  });
  const internals = manager as unknown as { providers: Map<string, { createSession: (value: Record<string, unknown>) => Promise<unknown> }> };
  const provider = internals.providers.get('copilot')!;
  const original = provider.createSession;
  provider.createSession = async (value) => { options = value; return original(value); };
  assert.equal(manager.startAgent(task('coding-regression'), async (status) => { statuses.push(status); }), true);
  await waitFor(() => statuses.includes('complete'), 'coding run did not complete');
  assert.equal(prompt, 'Lifecycle test\n\nExercise lifecycle ordering.');
  assert.match(String(options?.systemPrompt), /You are a coding agent/);
});

test('exact-attempt stop cannot terminate a successor session', async () => {
  const manager = new AgentManager();
  const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
  sessions.set('attempt-fence', {
    runToken: Symbol('successor'), attemptId: 'attempt-2', startTime: Date.now(), agentType: 'copilot',
    session: { abort: async () => {}, destroy: async () => {} },
  });
  assert.equal(await manager.stopAgent('attempt-fence', 'attempt-1'), false);
  assert.equal(manager.isRunning('attempt-fence'), true);
  assert.equal(await manager.stopAgent('attempt-fence', 'attempt-2'), true);
  assert.equal(manager.isRunning('attempt-fence'), false);
});

test('sandboxed Hermes selects a separate plain command for agent-default', () => {
  assert.equal(hermesCommandForExecution('coding', { HERMES_COMMAND: '/sandbox/hermes' }), '/sandbox/hermes');
  assert.equal(hermesCommandForExecution('agent-default', {}), 'hermes');
  assert.equal(hermesCommandForExecution('agent-default', { HERMES_AGENT_DEFAULT_COMMAND: '/plain/hermes' }), '/plain/hermes');
  assert.equal(usesTaskScopedHermesProvider('hermes', 'agent-default', 'false'), true);
  assert.equal(usesTaskScopedHermesProvider('hermes', 'coding', 'false'), false);
  assert.equal(usesTaskScopedHermesProvider('hermes', 'coding', 'true'), true);
  assert.equal(usesTaskScopedHermesProvider('copilot', 'agent-default', 'true'), false);
});
