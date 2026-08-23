import { Router, type Request, type Response } from 'express';
import type { Task } from '../types.js';
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
    output.origin = nestedOrigin;
  }
  return Object.keys(output).length ? output : undefined;
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
    const task = await repo.getById(String(req.params.id));
    if (!task || !task.externalSource) {
      res.status(404).json({ error: 'orchestration not found' });
      return;
    }
    const deepLink = taskLink(req, task.projectId, task.id);
    res.json({ task, contract: { projectId: task.projectId, taskId: task.id, deepLink } });
  }));

  router.post('/:id/message', asyncHandler(async (req: Request, res: Response) => {
    const task = await repo.getById(String(req.params.id));
    if (!task || !task.externalSource) {
      res.status(404).json({ error: 'orchestration not found' });
      return;
    }
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
    const task = await repo.getById(String(req.params.id));
    if (!task || !task.externalSource) {
      res.status(404).json({ error: 'orchestration not found' });
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
    const timeoutMinutes = req.body.timeoutMinutes ?? req.body.timeout_minutes ?? task.timeoutMinutes;
    if (timeoutMinutes !== undefined && !isValidAgentTimeoutMinutes(timeoutMinutes)) {
      res.status(400).json({ error: `timeoutMinutes must be an integer between ${MIN_AGENT_TIMEOUT_MINUTES} and ${MAX_AGENT_TIMEOUT_MINUTES}` });
      return;
    }
    const ready = agents.getAvailableAgents().find((agent) => agent.name === task.agentType);
    if (!ready?.available) {
      res.status(409).json({ error: `agent ${task.agentType} is not ready`, reason: ready?.reason });
      return;
    }
    const reset = await repo.update(task.id, {
      agentStatus: 'idle',
      columnId: 'in-progress',
      startedAt: undefined,
      completedAt: undefined,
      timeoutMinutes,
    });
    if (!reset) {
      res.status(500).json({ error: 'failed to reset orchestration' });
      return;
    }
    await repo.requestRun(task.id, Date.now());
    broadcastTaskUpdate(reset);
    queueMicrotask(() => {
      void startAgentForTask(reset, repo, agents).catch((err) => {
        console.error(`[orchestrations] failed to retry task ${task.id}:`, err);
      });
    });
    const deepLink = taskLink(req, reset.projectId, reset.id);
    res.status(202).json({ task: reset, contract: { projectId: reset.projectId, taskId: reset.id, deepLink } });
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
      const taskMatches = await repo.resolve(existingReference, project.id);
      if (!taskMatches.length) { res.status(404).json({ error: 'task not found in selected project' }); return; }
      if (taskMatches.length > 1) {
        res.status(409).json({ error: 'task reference is ambiguous', matches: taskMatches.map(({ id, title }) => ({ id, title })) }); return;
      }
      const existing = taskMatches[0];
      if (agents.isRunning(existing.id)) {
        res.status(409).json({ error: 'agent is already running for this task; use the message endpoint' }); return;
      }
      const requestedAgent = req.body.agentType ?? req.body.agent ?? existing.agentType;
      if (!isValidAgentType(requestedAgent)) { res.status(400).json({ error: 'agent must be a supported agent type' }); return; }
      const autoStart = req.body.autoStart ?? req.body.auto_start ?? true;
      if (typeof autoStart !== 'boolean') { res.status(400).json({ error: 'autoStart must be a boolean' }); return; }
      const timeoutMinutes = req.body.timeoutMinutes ?? req.body.timeout_minutes ?? existing.timeoutMinutes;
      if (timeoutMinutes !== undefined && timeoutMinutes !== null && !isValidAgentTimeoutMinutes(timeoutMinutes)) {
        res.status(400).json({ error: `timeoutMinutes must be an integer between ${MIN_AGENT_TIMEOUT_MINUTES} and ${MAX_AGENT_TIMEOUT_MINUTES}` }); return;
      }
      if (autoStart) {
        const ready = agents.getAvailableAgents().find((agent) => agent.name === requestedAgent);
        if (!ready?.available) { res.status(409).json({ error: `agent ${requestedAgent} is not ready`, reason: ready?.reason }); return; }
      }
      if (relatedReference !== undefined) {
        const related = await resolveRelatedTask(repo, project.id, relatedReference, res);
        if (!related) return;
        if (related.id === existing.id) { res.status(400).json({ error: 'a task cannot be related to itself' }); return; }
        await repo.createRelationship(existing.id, related.id, Date.now());
      }
      const continuationDescription = req.body.description;
      if (continuationDescription !== undefined && typeof continuationDescription !== 'string') {
        res.status(400).json({ error: 'description must be a string' }); return;
      }
      if (typeof continuationDescription === 'string' && continuationDescription.length > MAX_DESCRIPTION_LENGTH) {
        res.status(400).json({ error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` }); return;
      }
      const reset = await repo.update(existing.id, {
        agentType: requestedAgent,
        description: continuationDescription ?? existing.description,
        agentStatus: 'idle',
        columnId: autoStart ? 'in-progress' : 'backlog',
        archived: false,
        startedAt: undefined,
        completedAt: undefined,
        runRequestedAt: undefined,
        runClaimedAt: undefined,
        timeoutMinutes,
      });
      if (!reset) { res.status(500).json({ error: 'failed to continue task' }); return; }
      if (autoStart) await repo.requestRun(reset.id, Date.now());
      broadcastTaskUpdate(reset);
      if (autoStart) queueMicrotask(() => {
        void startAgentForTask(reset, repo, agents).catch((err) => console.error(`[orchestrations] failed to continue task ${reset.id}:`, err));
      });
      const deepLink = taskLink(req, reset.projectId, reset.id);
      res.status(202).json({ task: reset, continuation: true, contract: { projectId: reset.projectId, taskId: reset.id, deepLink } });
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

    const relatedTask = relatedReference === undefined
      ? undefined
      : await resolveRelatedTask(repo, project.id, relatedReference, res);
    if (relatedReference !== undefined && !relatedTask) return;

    const task = buildTask({
      title,
      description,
      projectId: project.id,
      repoPath: project.repoPath,
      agentType,
      priority: req.body.priority ?? project.defaultPriority,
      columnId: autoStart ? 'in-progress' : 'backlog',
      baseBranch,
      branchName,
      useWorktree: true,
      externalSource: 'hermes',
      externalKey: key,
      provenance: sanitizeOrigin(req.body.provenance ?? req.body.origin),
      runRequestedAt: autoStart ? Date.now() : undefined,
      timeoutMinutes,
    });

    const result = await repo.createIdempotent(task);
    const deepLink = taskLink(req, result.task.projectId, result.task.id);
    if (!result.created) {
      const conflicts = result.task.projectId !== task.projectId
        || result.task.agentType !== task.agentType
        || result.task.title !== task.title
        || result.task.description !== task.description
        || result.task.branchName !== task.branchName
        || result.task.baseBranch !== task.baseBranch
        || result.task.timeoutMinutes !== task.timeoutMinutes;
      if (conflicts) {
        res.status(409).json({ error: 'idempotency key was already used for a different orchestration request' });
        return;
      }
      if (relatedTask) await repo.createRelationship(result.task.id, relatedTask.id, Date.now());
      res.status(200).set('Idempotent-Replay', 'true').json({
        task: result.task,
        contract: { projectId: result.task.projectId, taskId: result.task.id, deepLink },
      });
      return;
    }

    if (relatedTask) await repo.createRelationship(task.id, relatedTask.id, Date.now());
    broadcastTaskUpdate(task);
    if (autoStart) {
      queueMicrotask(() => {
        void startAgentForTask(task, repo, agents).catch((err) => {
          console.error(`[orchestrations] failed to dispatch task ${task.id}:`, err);
        });
      });
    }
    const current = await repo.getById(task.id) || task;
    res.status(201).json({
      task: current,
      contract: { projectId: project.id, taskId: task.id, deepLink },
    });
  }));

  return router;
}
