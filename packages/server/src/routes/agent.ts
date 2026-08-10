import { Router, Request, Response } from 'express';
import path from 'path';
import type { Task } from '../types.js';
import { isValidAgentType, VALID_AGENT_TYPES } from '@ai-agent-board/shared/constants.js';
import type { TaskRepository } from '../repositories/types.js';
import type { TaskGroupRepository } from '../repositories/group-types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import { broadcast } from '../websocket.js';
import type { AgentManager } from '../services/agent-manager.js';
import {
  asyncHandler, paramId, isAllowedRepoPath, expandTilde, isValidGitRef, normalizeRepoPathForCompare,
  broadcastTaskUpdate, broadcastGroupUpdate, makeStatusCallback, makeWorktreeCallback, isRateLimited,
} from './helpers.js';

export function createAgentRouter(
  repo: TaskRepository,
  agentManager: AgentManager,
  groupRepo?: TaskGroupRepository,
  projectRepo?: ProjectRepository,
): Router {
  const router = Router();

  // POST /api/tasks/:id/configure — store worktree config before running
  router.post('/:id/configure', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    const { repoPath, branchName, baseBranch, useWorktree, agentType } = req.body;
    const project = projectRepo ? await projectRepo.getById(task.projectId ?? 'default') : undefined;
    if (req.body.projectId !== undefined && req.body.projectId !== (task.projectId ?? 'default')) {
      res.status(400).json({ error: 'projectId is immutable' });
      return;
    }
    if (projectRepo && !project) {
      res.status(400).json({ error: 'task project not found' });
      return;
    }

    if (repoPath !== undefined && typeof repoPath !== 'string') {
      res.status(400).json({ error: 'repoPath must be a string' });
      return;
    }
    if (branchName !== undefined && typeof branchName !== 'string') {
      res.status(400).json({ error: 'branchName must be a string' });
      return;
    }
    if (baseBranch !== undefined && typeof baseBranch !== 'string') {
      res.status(400).json({ error: 'baseBranch must be a string' });
      return;
    }
    if (useWorktree !== undefined && typeof useWorktree !== 'boolean') {
      res.status(400).json({ error: 'useWorktree must be a boolean' });
      return;
    }
    if (agentType !== undefined && !isValidAgentType(agentType)) {
      res.status(400).json({ error: `invalid agentType: must be one of ${VALID_AGENT_TYPES.join(', ')}` });
      return;
    }
    if (typeof branchName === 'string' && branchName !== '' && !isValidGitRef(branchName)) {
      res.status(400).json({ error: 'branchName contains invalid characters' });
      return;
    }
    if (typeof baseBranch === 'string' && !isValidGitRef(baseBranch)) {
      res.status(400).json({ error: 'baseBranch contains invalid characters' });
      return;
    }
    if (typeof repoPath === 'string') {
      if (project?.repoPath && normalizeRepoPathForCompare(repoPath) !== normalizeRepoPathForCompare(project.repoPath)) {
        res.status(400).json({ error: 'repoPath is locked by the task project' });
        return;
      }
      const expandedRepoPath = expandTilde(repoPath);
      if (!path.isAbsolute(expandedRepoPath)) {
        res.status(400).json({ error: 'repoPath must be an absolute path (e.g. ~/projects/my-app or C:\\Users\\you\\projects\\my-app)' });
        return;
      }
      const repoErr = isAllowedRepoPath(expandedRepoPath);
      if (repoErr) {
        res.status(400).json({ error: repoErr });
        return;
      }
    }

    const updates: Partial<Task> = {};
    if (repoPath !== undefined && !project?.repoPath) updates.repoPath = typeof repoPath === 'string' ? expandTilde(repoPath) : repoPath;
    if (branchName !== undefined) updates.branchName = branchName || undefined;
    if (baseBranch !== undefined) updates.baseBranch = baseBranch;
    if (useWorktree !== undefined) updates.useWorktree = useWorktree;
    if (agentType !== undefined) updates.agentType = agentType;

    const updated = await repo.update(id, updates);
    if (!updated) {
      res.status(500).json({ error: 'failed to update task' });
      return;
    }
    broadcastTaskUpdate(updated);
    res.json(updated);
  }));

  // POST /api/tasks/:id/run
  router.post('/:id/run', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    if (isRateLimited(id)) {
      res.status(429).json({ error: 'too many requests, try again shortly' });
      return;
    }
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (agentManager.isRunning(task.id)) {
      res.status(409).json({ error: 'agent already running for this task' });
      return;
    }

    // Persist intent before claiming; a crash between these operations is recovered at startup.
    agentManager.resetEvents(task.id);
    await repo.requestRun(task.id, Date.now());
    const claimed = await repo.claimRun(task.id, Date.now());
    if (!claimed) { res.status(409).json({ error: 'run already claimed' }); return; }

    const updates: Partial<Task> = {
      agentStatus: 'planning',
      startedAt: Date.now(),
      completedAt: undefined,
    };
    if (task.columnId === 'backlog') {
      updates.columnId = 'in-progress';
    }
    const updated = await repo.update(task.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    broadcastTaskUpdate(updated);

    // E8: If this task belongs to a group in 'review', move group back to in-progress
    if (updated.groupId && groupRepo) {
      const group = await groupRepo.getById(updated.groupId);
      if (group && group.columnId === 'review') {
        const movedGroup = await groupRepo.update(group.id, {
          columnId: 'in-progress',
          completedAt: undefined,
        });
        if (movedGroup) broadcastGroupUpdate(movedGroup);
      }
    }

    agentManager.startAgent(updated, makeStatusCallback(repo, task.id), makeWorktreeCallback(repo, task.id));

    res.json(updated);
  }));

  // POST /api/tasks/:id/stop
  router.post('/:id/stop', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    if (isRateLimited(id)) {
      res.status(429).json({ error: 'too many requests, try again shortly' });
      return;
    }
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    const stopped = await agentManager.stopAgent(task.id);
    if (!stopped) {
      res.status(409).json({ error: 'no running agent for this task' });
      return;
    }
    const updated = await repo.update(task.id, { agentStatus: 'failed' });
    if (!updated) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    broadcastTaskUpdate(updated);
    res.json(updated);
  }));

  // POST /api/tasks/:id/message — send a follow-up message to a running agent
  router.post('/:id/message', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    const { message, attachmentIds } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required and must be a non-empty string' });
      return;
    }

    if (!agentManager.isRunning(task.id)) {
      res.status(409).json({ error: 'no running agent for this task' });
      return;
    }

    try {
      const validIds = Array.isArray(attachmentIds) ? attachmentIds.filter((id: unknown) => typeof id === 'string') : undefined;
      await agentManager.sendMessage(task.id, message, validIds);
      broadcast({ type: 'agent_follow_up', payload: { taskId: task.id, message, attachmentIds: validIds } });
      res.json({ success: true });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'failed to send message' });
    }
  }));

  // GET /api/tasks/:id/events?since=<timestamp>&limit=<n>
  router.get('/:id/events', asyncHandler(async (req: Request, res: Response) => {
    if (!await repo.getById(paramId(req))) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    let events = await agentManager.getEvents(paramId(req));
    const since = Number(req.query.since);
    if (since > 0) {
      events = events.filter(e => e.timestamp > since);
    }
    const limit = Number(req.query.limit);
    if (limit > 0) {
      events = events.slice(-limit);
    }
    res.json(events);
  }));

  return router;
}
