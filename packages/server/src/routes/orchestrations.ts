import { Router, type Request, type Response } from 'express';
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
  isValidPriority,
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
    const deepLink = `/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.id)}`;
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
    await agents.sendMessage(task.id, req.body.message.trim());
    res.json({ success: true });
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
      externalSource: req.body.externalSource || 'hermes',
      externalKey: key,
      provenance: sanitizeOrigin(req.body.provenance ?? req.body.origin),
      runRequestedAt: autoStart ? Date.now() : undefined,
    });

    const result = await repo.createIdempotent(task);
    const deepLink = `/projects/${encodeURIComponent(result.task.projectId)}/tasks/${encodeURIComponent(result.task.id)}`;
    if (!result.created) {
      res.status(200).set('Idempotent-Replay', 'true').json({
        task: result.task,
        contract: { projectId: result.task.projectId, taskId: result.task.id, deepLink },
      });
      return;
    }

    broadcastTaskUpdate(task);
    if (autoStart) {
      await startAgentForTask(task, repo, agents);
    }
    const current = await repo.getById(task.id) || task;
    res.status(201).json({
      task: current,
      contract: { projectId: project.id, taskId: task.id, deepLink },
    });
  }));

  return router;
}
