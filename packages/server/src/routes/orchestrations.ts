import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Task, ExecutionAttempt } from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import type { AgentManager } from '../services/agent-manager.js';
import {
  asyncHandler,
  buildTask,
  broadcastTaskUpdate,
  isValidGitRef,
  startAgentForTask,
} from './helpers.js';
import {
  isValidAgentType,
  isValidAgentTimeoutMinutes,
  isValidPriority,
  MIN_AGENT_TIMEOUT_MINUTES,
  MAX_AGENT_TIMEOUT_MINUTES,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
} from '@ai-agent-board/shared/constants.js';

function sanitizeOrigin(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const mappings: Array<[string, string]> = [
    ['sourceProfile', 'sourceProfile'],
    ['profile', 'sourceProfile'],
    ['sourcePlatform', 'sourcePlatform'],
    ['platform', 'sourcePlatform'],
    ['sourceSession', 'sourceSession'],
    ['sessionId', 'sourceSession'],
    ['sourceMessage', 'sourceMessage'],
    ['messageId', 'sourceMessage'],
    ['sourceTask', 'sourceTask'],
    ['hermesTaskId', 'sourceTask'],
    ['requestedBy', 'requestedBy'],
  ];
  for (const [inputKey, outputKey] of mappings) {
    const item = input[inputKey];
    if (typeof item === 'string' && item.trim() && !(outputKey in output)) {
      output[outputKey] = item.trim().slice(0, 500);
    }
  }
  const nestedOrigin = input.origin;
  if (nestedOrigin && typeof nestedOrigin === 'object' && !Array.isArray(nestedOrigin)) {
    const sanitized: Record<string, string | number | boolean | null> = {};
    for (const key of Object.keys(nestedOrigin).sort().slice(0, 50)) {
      const item = (nestedOrigin as Record<string, unknown>)[key];
      if (typeof item === 'string') sanitized[key.slice(0, 100)] = item.slice(0, 500);
      else if (typeof item === 'number' && Number.isFinite(item)) sanitized[key.slice(0, 100)] = item;
      else if (typeof item === 'boolean' || item === null) sanitized[key.slice(0, 100)] = item as boolean | null;
    }
    if (Object.keys(sanitized).length) output.origin = sanitized;
  }
  return Object.keys(output).length ? output : undefined;
}

function canonicalJson(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort()
        .filter((key) => (item as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, canonicalize((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(canonicalize(value));
}

function generateBranchName(key: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
  const suffix = key.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase() || Date.now().toString(36);
  return `agent/${slug}-${suffix}`;
}

function taskLink(req: Request, projectId: string, taskId: string): string {
  const configured = process.env.AGENT_BOARD_PUBLIC_URL?.trim().replace(/\/$/, '');
  const origin = configured || `${req.protocol}://${req.get('host')}`;
  return `${origin}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
}

function attemptConflicts(actual: ExecutionAttempt, expected: ExecutionAttempt): boolean {
  return actual.requestSnapshot !== expected.requestSnapshot;
}

async function orchestrationTask(repo: TaskRepository, id: string): Promise<{ task: Task; attempts: ExecutionAttempt[] } | undefined> {
  const addressedAttempt = await repo.getAttemptById(id);
  const task = await repo.getById(addressedAttempt?.taskId ?? id);
  if (!task) return undefined;
  const attempts = await repo.getAttemptsByTaskId(task.id);
  return attempts.length ? { task, attempts } : undefined;
}

async function resolveRelatedTask(repo: TaskRepository, projectId: string, reference: unknown, res: Response): Promise<Task | undefined> {
  if (typeof reference !== 'string' || !reference.trim()) {
    res.status(400).json({ error: 'relatedItem must be an exact task id or title' });
    return undefined;
  }
  const matches = await repo.resolve(reference, projectId);
  if (!matches.length) {
    res.status(404).json({ error: 'related task not found in selected project' });
    return undefined;
  }
  if (matches.length > 1) {
    res.status(409).json({ error: 'related task reference is ambiguous', matches: matches.map(({ id, title }) => ({ id, title })) });
    return undefined;
  }
  return matches[0];
}

export function createOrchestrationsRouter(
  repo: TaskRepository,
  projects: ProjectRepository,
  agents: AgentManager,
): Router {
  const router = Router();

  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const addressedAttempt = await repo.getAttemptById(id);
    const task = await repo.getById(addressedAttempt?.taskId ?? id);
    const attempts = task ? await repo.getAttemptsByTaskId(task.id) : [];
    if (!task || (!addressedAttempt && attempts.length === 0)) {
      res.status(404).json({ error: 'orchestration not found' });
      return;
    }
    const attempt = addressedAttempt ?? attempts[attempts.length - 1];
    const deepLink = taskLink(req, task.projectId, task.id);
    res.json({ task, attempt, attempts, contract: { projectId: task.projectId, taskId: task.id, attemptId: attempt?.id, deepLink } });
  }));

  router.post('/:id/message', asyncHandler(async (req: Request, res: Response) => {
    const orchestration = await orchestrationTask(repo, String(req.params.id));
    if (!orchestration) {
      res.status(404).json({ error: 'orchestration not found' });
      return;
    }
    const { task } = orchestration;
    if (typeof req.body.message !== 'string' || !req.body.message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const delivered = await agents.sendMessage(task.id, req.body.message.trim());
    if (!delivered) {
      res.status(409).json({ error: 'agent is not currently running for this orchestration' });
      return;
    }
    res.json({ success: true });
  }));

  router.post('/:id/retry', asyncHandler(async (req: Request, res: Response) => {
    const orchestration = await orchestrationTask(repo, String(req.params.id));
    if (!orchestration) {
      res.status(404).json({ error: 'orchestration not found' });
      return;
    }
    const { task } = orchestration;
    if (!isValidAgentType(task.agentType)) { res.status(409).json({ error: 'orchestration has no supported agent' }); return; }
    const retryAgent = task.agentType;
    const key = req.header('Idempotency-Key')?.trim();
    if (!key) { res.status(400).json({ error: 'Idempotency-Key is required' }); return; }
    if (key.length > 200) { res.status(400).json({ error: 'Idempotency-Key is too long' }); return; }
    const timeoutMinutes = req.body.timeoutMinutes ?? req.body.timeout_minutes ?? task.timeoutMinutes;
    if (timeoutMinutes !== undefined && !isValidAgentTimeoutMinutes(timeoutMinutes)) {
      res.status(400).json({ error: `timeoutMinutes must be an integer between ${MIN_AGENT_TIMEOUT_MINUTES} and ${MAX_AGENT_TIMEOUT_MINUTES}` });
      return;
    }
    const provenance = sanitizeOrigin(req.body.provenance ?? req.body.origin);
    const expectedAttempt: ExecutionAttempt = {
      id: randomUUID(), taskId: task.id, externalSource: 'hermes', externalKey: key,
      titleSnapshot: task.title, descriptionSnapshot: task.description, agentType: retryAgent,
      autoStart: true, timeoutMinutes, status: 'dispatched', createdAt: Date.now(),
      requestSnapshot: canonicalJson({ kind: 'retry', projectId: task.projectId, taskId: task.id, title: task.title,
        description: task.description, priority: task.priority, agent: retryAgent, baseBranch: task.baseBranch ?? null,
        branchName: task.branchName ?? null, timeoutMinutes: timeoutMinutes ?? null, autoStart: true, relatedTaskId: null,
        provenance: provenance ?? null }),
    };
    const replay = await repo.getAttemptByExternalIdentity('hermes', key);
    if (replay) {
      if (attemptConflicts(replay, expectedAttempt)) { res.status(409).json({ error: 'idempotency key was already used for a different orchestration request' }); return; }
      const replayTask = await repo.getById(replay.taskId);
      if (!replayTask) { res.status(500).json({ error: 'retry attempt references a missing task' }); return; }
      const deepLink = taskLink(req, replayTask.projectId, replayTask.id);
      res.status(200).set('Idempotent-Replay', 'true').json({ task: replayTask, attempt: replay,
        contract: { projectId: replayTask.projectId, taskId: replayTask.id, attemptId: replay.id, deepLink } });
      return;
    }
    if (agents.isRunning(task.id)) {
      res.status(409).json({ error: 'agent is already running for this orchestration' });
      return;
    }
    if (task.agentStatus !== 'failed') {
      res.status(409).json({ error: 'only failed or timed-out orchestrations can be retried' });
      return;
    }
    const ready = agents.getAvailableAgents().find((agent) => agent.name === retryAgent);
    if (!ready?.available) {
      res.status(409).json({ error: `agent ${retryAgent} is not ready`, reason: ready?.reason });
      return;
    }
    const result = await repo.continueOrchestration(task.id, {
      agentStatus: 'idle',
      columnId: 'in-progress',
      startedAt: undefined,
      completedAt: undefined,
      timeoutMinutes,
      runRequestedAt: Date.now(),
      runClaimedAt: undefined,
    }, expectedAttempt, undefined, undefined, { requiredAgentStatus: 'failed', requireRunnable: true });
    if (!result) {
      res.status(409).json({ error: 'orchestration is no longer eligible for retry' });
      return;
    }
    if (!result.created) {
      if (attemptConflicts(result.attempt, expectedAttempt)) { res.status(409).json({ error: 'idempotency key was already used for a different orchestration request' }); return; }
      const deepLink = taskLink(req, result.task.projectId, result.task.id);
      res.status(200).set('Idempotent-Replay', 'true').json({ task: result.task, attempt: result.attempt,
        contract: { projectId: result.task.projectId, taskId: result.task.id, attemptId: result.attempt.id, deepLink } });
      return;
    }
    const reset = result.task;
    broadcastTaskUpdate(reset);
    queueMicrotask(() => {
      void startAgentForTask(reset, repo, agents).catch((err) => {
        console.error(`[orchestrations] failed to retry task ${task.id}:`, err);
      });
    });
    const deepLink = taskLink(req, reset.projectId, reset.id);
    res.status(202).json({ task: reset, attempt: result.attempt,
      contract: { projectId: reset.projectId, taskId: reset.id, attemptId: result.attempt.id, deepLink } });
  }));

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const projectReference = req.body.project;
    if (typeof projectReference !== 'string' || !projectReference.trim()) {
      res.status(400).json({ error: 'project is required (id, name, or alias)' });
      return;
    }

    const matches = await projects.resolve(projectReference);
    if (matches.length === 0) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    if (matches.length > 1) {
      res.status(409).json({
        error: 'project reference is ambiguous',
        matches: matches.map((project) => ({ id: project.id, name: project.name })),
      });
      return;
    }
    const project = matches[0];
    if (!project.repoPath) {
      res.status(409).json({ error: 'project must have a repository path before coding work can start' });
      return;
    }

    const existingReference = req.body.task ?? req.body.taskId ?? req.body.item ?? req.body.itemId ?? req.body.continueTask ?? req.body.continueTaskId;
    const relatedReference = req.body.relatedItem ?? req.body.relatedTask ?? req.body.relatedTaskId;
    if (existingReference !== undefined) {
      if (typeof existingReference !== 'string' || !existingReference.trim()) {
        res.status(400).json({ error: 'task must be an exact id or title' }); return;
      }
      const key = (req.header('Idempotency-Key') || req.body.externalKey)?.trim();
      if (!key) { res.status(400).json({ error: 'Idempotency-Key is required' }); return; }
      if (key.length > 200) { res.status(400).json({ error: 'Idempotency-Key is too long' }); return; }
      const taskMatches = await repo.resolve(existingReference, project.id);
      if (!taskMatches.length) { res.status(404).json({ error: 'task not found in selected project' }); return; }
      if (taskMatches.length > 1) {
        res.status(409).json({ error: 'task reference is ambiguous', matches: taskMatches.map(({ id, title }) => ({ id, title })) }); return;
      }
      const existing = taskMatches[0];
      const requestedAgent = req.body.agentType ?? req.body.agent ?? existing.agentType;
      if (!isValidAgentType(requestedAgent)) { res.status(400).json({ error: 'agent must be a supported agent type' }); return; }
      const autoStart = req.body.autoStart ?? req.body.auto_start ?? true;
      if (typeof autoStart !== 'boolean') { res.status(400).json({ error: 'autoStart must be a boolean' }); return; }
      const timeoutMinutes = req.body.timeoutMinutes ?? req.body.timeout_minutes ?? existing.timeoutMinutes;
      if (timeoutMinutes !== undefined && timeoutMinutes !== null && !isValidAgentTimeoutMinutes(timeoutMinutes)) {
        res.status(400).json({ error: `timeoutMinutes must be an integer between ${MIN_AGENT_TIMEOUT_MINUTES} and ${MAX_AGENT_TIMEOUT_MINUTES}` }); return;
      }
      const continuationDescription = req.body.description;
      if (continuationDescription !== undefined && typeof continuationDescription !== 'string') {
        res.status(400).json({ error: 'description must be a string' }); return;
      }
      if (typeof continuationDescription === 'string' && continuationDescription.length > MAX_DESCRIPTION_LENGTH) {
        res.status(400).json({ error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` }); return;
      }
      const continuationTitle = req.body.title === undefined ? existing.title : (typeof req.body.title === 'string' ? req.body.title.trim() : '');
      if (!continuationTitle || continuationTitle.length > MAX_TITLE_LENGTH) {
        res.status(400).json({ error: `title must be a non-empty string at most ${MAX_TITLE_LENGTH} characters` }); return;
      }
      const priority = req.body.priority ?? existing.priority;
      if (!isValidPriority(priority)) { res.status(400).json({ error: 'invalid priority' }); return; }
      const baseBranch = req.body.baseBranch ?? existing.baseBranch;
      const branchName = req.body.branchName ?? existing.branchName;
      if (baseBranch !== undefined && (typeof baseBranch !== 'string' || !isValidGitRef(baseBranch))) {
        res.status(400).json({ error: 'baseBranch is not a valid git ref' }); return;
      }
      if (branchName !== undefined && (typeof branchName !== 'string' || !isValidGitRef(branchName))) {
        res.status(400).json({ error: 'branchName is not a valid git ref' }); return;
      }
      const related = relatedReference === undefined ? undefined : await resolveRelatedTask(repo, project.id, relatedReference, res);
      if (relatedReference !== undefined && !related) return;
      if (related?.id === existing.id) { res.status(400).json({ error: 'a task cannot be related to itself' }); return; }

      const provenance = sanitizeOrigin(req.body.provenance ?? req.body.origin);
      const expectedAttempt: ExecutionAttempt = {
        id: randomUUID(), taskId: existing.id, externalSource: 'hermes', externalKey: key,
        titleSnapshot: continuationTitle, descriptionSnapshot: continuationDescription ?? existing.description,
        agentType: requestedAgent, relatedTaskId: related?.id, autoStart, timeoutMinutes,
        status: autoStart ? 'dispatched' : 'pending', createdAt: Date.now(),
        requestSnapshot: canonicalJson({ kind: 'continuation', projectId: project.id, taskId: existing.id,
          title: continuationTitle, description: continuationDescription ?? existing.description, priority, agent: requestedAgent,
          baseBranch: baseBranch ?? null, branchName: branchName ?? null, timeoutMinutes: timeoutMinutes ?? null,
          autoStart, relatedTaskId: related?.id ?? null, provenance: provenance ?? null }),
      };
      const replay = await repo.getAttemptByExternalIdentity('hermes', key);
      if (replay) {
        if (attemptConflicts(replay, expectedAttempt)) {
          res.status(409).json({ error: 'idempotency key was already used for a different orchestration request' }); return;
        }
        const replayTask = await repo.getById(replay.taskId);
        if (!replayTask) { res.status(500).json({ error: 'execution attempt references a missing task' }); return; }
        const deepLink = taskLink(req, replayTask.projectId, replayTask.id);
        res.status(200).set('Idempotent-Replay', 'true').json({ task: replayTask, attempt: replay, continuation: true,
          contract: { projectId: replayTask.projectId, taskId: replayTask.id, attemptId: replay.id, deepLink } });
        return;
      }
      if (agents.isRunning(existing.id)) {
        res.status(409).json({ error: 'agent is already running for this task; use the message endpoint' }); return;
      }
      if (autoStart) {
        const ready = agents.getAvailableAgents().find((agent) => agent.name === requestedAgent);
        if (!ready?.available) { res.status(409).json({ error: `agent ${requestedAgent} is not ready`, reason: ready?.reason }); return; }
      }
      const aggregate = await repo.continueOrchestration(existing.id, {
        agentType: requestedAgent, title: continuationTitle, description: continuationDescription ?? existing.description,
        priority, baseBranch, branchName,
        agentStatus: 'idle', columnId: autoStart ? 'in-progress' : 'backlog', archived: false,
        startedAt: undefined, completedAt: undefined, runRequestedAt: autoStart ? Date.now() : undefined,
        runClaimedAt: undefined, timeoutMinutes,
      }, expectedAttempt, related?.id, Date.now(), autoStart ? { requireRunnable: true } : undefined);
      if (!aggregate) { res.status(409).json({ error: 'task is no longer eligible to start' }); return; }
      if (!aggregate.created) {
        if (attemptConflicts(aggregate.attempt, expectedAttempt)) {
          res.status(409).json({ error: 'idempotency key was already used for a different orchestration request' }); return;
        }
        const deepLink = taskLink(req, aggregate.task.projectId, aggregate.task.id);
        res.status(200).set('Idempotent-Replay', 'true').json({ task: aggregate.task, attempt: aggregate.attempt, continuation: true,
          contract: { projectId: aggregate.task.projectId, taskId: aggregate.task.id, attemptId: aggregate.attempt.id, deepLink } });
        return;
      }
      const reset = aggregate.task;
      broadcastTaskUpdate(reset);
      if (autoStart) queueMicrotask(() => {
        void startAgentForTask(reset, repo, agents).catch((err) => console.error(`[orchestrations] failed to continue task ${reset.id}:`, err));
      });
      const deepLink = taskLink(req, reset.projectId, reset.id);
      res.status(202).json({ task: reset, attempt: aggregate.attempt, continuation: true,
        contract: { projectId: reset.projectId, taskId: reset.id, attemptId: aggregate.attempt.id, deepLink } });
      return;
    }

    const agentType = req.body.agentType ?? req.body.agent;
    if (!isValidAgentType(agentType)) {
      res.status(400).json({ error: 'agent is required and must be a supported agent type' });
      return;
    }

    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    if (title.length > MAX_TITLE_LENGTH) {
      res.status(400).json({ error: `title must be at most ${MAX_TITLE_LENGTH} characters` });
      return;
    }
    const description = typeof req.body.description === 'string' ? req.body.description : '';
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      res.status(400).json({ error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` });
      return;
    }

    const key = (req.header('Idempotency-Key') || req.body.externalKey)?.trim();
    if (!key) {
      res.status(400).json({ error: 'Idempotency-Key is required' });
      return;
    }
    if (key.length > 200) {
      res.status(400).json({ error: 'Idempotency-Key is too long' });
      return;
    }
    if (req.body.priority && !isValidPriority(req.body.priority)) {
      res.status(400).json({ error: 'invalid priority' });
      return;
    }
    const timeoutMinutes = req.body.timeoutMinutes ?? req.body.timeout_minutes;
    if (timeoutMinutes !== undefined && !isValidAgentTimeoutMinutes(timeoutMinutes)) {
      res.status(400).json({ error: `timeoutMinutes must be an integer between ${MIN_AGENT_TIMEOUT_MINUTES} and ${MAX_AGENT_TIMEOUT_MINUTES}` });
      return;
    }

    const autoStart = req.body.autoStart ?? req.body.auto_start ?? true;
    if (typeof autoStart !== 'boolean') {
      res.status(400).json({ error: 'autoStart must be a boolean' });
      return;
    }

    const requestedIsolation = req.body.isolation;
    const useWorktree = req.body.useWorktree ?? (requestedIsolation === undefined ? true : requestedIsolation === 'worktree');
    if (useWorktree !== true) {
      res.status(400).json({ error: 'orchestrated coding tasks require worktree isolation' });
      return;
    }

    const baseBranch = req.body.baseBranch ?? project.defaultBaseBranch ?? 'main';
    if (typeof baseBranch !== 'string' || !isValidGitRef(baseBranch)) {
      res.status(400).json({ error: 'baseBranch is not a valid git ref' });
      return;
    }
    const branchName = req.body.branchName || generateBranchName(key, title);
    if (typeof branchName !== 'string' || !isValidGitRef(branchName)) {
      res.status(400).json({ error: 'branchName is not a valid git ref' });
      return;
    }

    const relatedTask = relatedReference === undefined
      ? undefined
      : await resolveRelatedTask(repo, project.id, relatedReference, res);
    if (relatedReference !== undefined && !relatedTask) return;

    const priority = req.body.priority ?? project.defaultPriority ?? 'medium';
    const provenance = sanitizeOrigin(req.body.provenance ?? req.body.origin);
    const task = buildTask({
      title,
      description,
      projectId: project.id,
      repoPath: project.repoPath,
      agentType,
      priority,
      columnId: autoStart ? 'in-progress' : 'backlog',
      baseBranch,
      branchName,
      useWorktree: true,
      externalSource: 'hermes',
      externalKey: key,
      provenance,
      runRequestedAt: autoStart ? Date.now() : undefined,
      timeoutMinutes,
    });

    const expectedAttempt: ExecutionAttempt = {
      id: randomUUID(), taskId: task.id, externalSource: 'hermes', externalKey: key,
      titleSnapshot: title, descriptionSnapshot: description, agentType, relatedTaskId: relatedTask?.id,
      autoStart, timeoutMinutes, status: autoStart ? 'dispatched' : 'pending', createdAt: Date.now(),
      requestSnapshot: canonicalJson({ kind: 'create', projectId: project.id, taskId: null, title, description, priority,
        agent: agentType, baseBranch, branchName, timeoutMinutes: timeoutMinutes ?? null, autoStart,
        relatedTaskId: relatedTask?.id ?? null, provenance: provenance ?? null }),
    };
    const replay = await repo.getAttemptByExternalIdentity('hermes', key);
    if (replay) {
      if (attemptConflicts(replay, expectedAttempt)) {
        res.status(409).json({ error: 'idempotency key was already used for a different orchestration request' });
        return;
      }
      const replayTask = await repo.getById(replay.taskId);
      if (!replayTask) {
        res.status(500).json({ error: 'create attempt references a missing task' });
        return;
      }
      res.status(200).set('Idempotent-Replay', 'true').json({
        task: replayTask, attempt: replay,
        contract: { projectId: replayTask.projectId, taskId: replayTask.id, attemptId: replay.id, deepLink: taskLink(req, replayTask.projectId, replayTask.id) },
      });
      return;
    }

    if (autoStart) {
      const ready = agents.getAvailableAgents().find((agent) => agent.name === agentType);
      if (!ready?.available) {
        res.status(409).json({
          error: `agent ${agentType} is not ready`,
          reason: ready?.reason,
        });
        return;
      }
    }

    const aggregate = await repo.createOrchestration(task, expectedAttempt, relatedTask?.id, Date.now());
    const deepLink = taskLink(req, aggregate.task.projectId, aggregate.task.id);
    if (!aggregate.created) {
      if (attemptConflicts(aggregate.attempt, expectedAttempt)) {
        res.status(409).json({ error: 'idempotency key was already used for a different orchestration request' });
        return;
      }
      res.status(200).set('Idempotent-Replay', 'true').json({
        task: aggregate.task, attempt: aggregate.attempt,
        contract: { projectId: aggregate.task.projectId, taskId: aggregate.task.id, attemptId: aggregate.attempt.id, deepLink },
      });
      return;
    }

    broadcastTaskUpdate(aggregate.task);
    if (autoStart) {
      queueMicrotask(() => {
        void startAgentForTask(aggregate.task, repo, agents).catch((err) => {
          console.error(`[orchestrations] failed to dispatch task ${aggregate.task.id}:`, err);
        });
      });
    }
    res.status(201).json({
      task: aggregate.task, attempt: aggregate.attempt,
      contract: { projectId: project.id, taskId: aggregate.task.id, attemptId: aggregate.attempt.id, deepLink },
    });
  }));

  return router;
}
