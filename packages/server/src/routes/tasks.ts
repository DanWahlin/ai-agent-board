import { Router, Request, Response } from 'express';
import path from 'path';
import type { Project, Task } from '../types.js';
import { isValidPriority, isValidColumnId, isValidAgentStatus, isValidAgentType, isValidAgentTimeoutMinutes, VALID_AGENT_TYPES, VALID_TRANSITIONS, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH, MIN_AGENT_TIMEOUT_MINUTES, MAX_AGENT_TIMEOUT_MINUTES } from '@ai-agent-board/shared/constants.js';
import type { TaskRepository } from '../repositories/types.js';
import type { ProjectRepository } from '../repositories/project-types.js';
import { broadcast } from '../websocket.js';
import type { AgentManager } from '../services/agent-manager.js';
import {
  asyncHandler, paramId, isAllowedRepoPath, expandTilde,
  validateTaskFields, buildTask, broadcastTaskUpdate,
  failTaskWithEvent, startAgentForTask, normalizeRepoPathForCompare,
} from './helpers.js';

export function createTaskRouter(repo: TaskRepository, agentManager: AgentManager, projectRepo: ProjectRepository): Router {
  const router = Router();

  // GET /api/tasks
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const includeArchived = req.query.includeArchived === 'true';
    const project = await getProjectForRequest(projectRepo, req.query.projectId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    res.json(await repo.getAll(includeArchived, project.id));
  }));

  // GET /api/tasks/archived
  router.get('/archived', asyncHandler(async (req: Request, res: Response) => {
    const project = await getProjectForRequest(projectRepo, req.query.projectId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    res.json(await repo.getArchivedTasks(project.id));
  }));

  // POST /api/tasks
  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const project = await getProjectForRequest(projectRepo, req.body.projectId);
    if (!project) { res.status(400).json({ error: 'projectId is invalid' }); return; }
    const enforced = enforceProjectRepoPath(req.body, project);
    if (typeof enforced === 'string') { res.status(400).json({ error: enforced }); return; }
    const body = applyProjectDefaults(enforced, project);

    const validationError = validateTaskFields(body);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const idempotencyKey = req.header('Idempotency-Key')?.trim();
    if (idempotencyKey && idempotencyKey.length > 200) { res.status(400).json({ error: 'Idempotency-Key is too long' }); return; }
    const task = buildTask({ ...body, externalSource: idempotencyKey ? (req.body.externalSource || 'api') : req.body.externalSource, externalKey: idempotencyKey || req.body.externalKey, provenance: sanitizeProvenance(req.body.provenance) });
    const creation = await repo.createIdempotent(task);
    if (!creation.created) { res.status(200).set('Idempotent-Replay', 'true').json(creation.task); return; }
    broadcastTaskUpdate(task);

    const { autoRun } = req.body;

    // autoRun: true — immediately start agent if columnId is in-progress
    if (autoRun === true && task.columnId === 'in-progress') {
      const agents = agentManager.getAvailableAgents();
      const agentInfo = agents.find(a => a.name === task.agentType);
      if (!agentInfo?.available) {
        const failed = await failTaskWithEvent(
          repo,
          task,
          `Agent ${agentInfo?.displayName || task.agentType || 'unknown'} is not available: ${agentInfo?.reason || 'unknown reason'}`,
        );
        res.status(201).json(failed || { ...task, agentStatus: 'failed' });
        return;
      }
      await repo.requestRun(task.id, Date.now());
      await startAgentForTask(task, repo, agentManager);
      const latest = await repo.getById(task.id);
      res.status(201).json(latest || task);
      return;
    }

    res.status(201).json(task);
  }));

  // POST /api/tasks/batch — create multiple tasks, optionally auto-run them
  router.post('/batch', asyncHandler(async (req: Request, res: Response) => {
    const { tasks: taskDefs } = req.body;

    if (!Array.isArray(taskDefs) || taskDefs.length === 0) {
      res.status(400).json({ error: 'tasks must be a non-empty array' });
      return;
    }

    if (taskDefs.length > 50) {
      res.status(400).json({ error: 'batch limit is 50 tasks' });
      return;
    }

    // Validate ALL tasks first (atomic — fail fast)
    for (let i = 0; i < taskDefs.length; i++) {
      const project = await getProjectForRequest(projectRepo, taskDefs[i].projectId);
      if (!project) {
        res.status(400).json({ error: `task[${i}]: projectId is invalid` });
        return;
      }
      const enforced = enforceProjectRepoPath(taskDefs[i], project);
      const body = typeof enforced === 'string' ? enforced : applyProjectDefaults(enforced, project);
      const err = typeof body === 'string' ? body : validateTaskFields(body);
      if (err) {
        res.status(400).json({ error: `task[${i}]: ${err}` });
        return;
      }
      taskDefs[i] = body;
    }

    // Create all tasks
    const created: Task[] = [];
    for (const def of taskDefs) {
      const task = buildTask(def);
      await repo.create(task);
      broadcastTaskUpdate(task);
      created.push(task);
    }

    // Auto-run tasks that requested it
    for (let i = 0; i < created.length; i++) {
      const task = created[i];
      const def = taskDefs[i];
      if (def.autoRun === true && task.columnId === 'in-progress') {
        const agents = agentManager.getAvailableAgents();
        const agentInfo = agents.find(a => a.name === task.agentType);
        if (!agentInfo?.available) {
          const failed = await failTaskWithEvent(
            repo,
            task,
            `Agent ${agentInfo?.displayName || task.agentType || 'unknown'} is not available: ${agentInfo?.reason || 'unknown reason'}`,
          );
          if (failed) created[i] = failed;
        } else {
          await repo.requestRun(task.id, Date.now());
          await startAgentForTask(task, repo, agentManager);
          const latest = await repo.getById(task.id);
          if (latest) created[i] = latest;
        }
      }
    }

    res.status(201).json({ tasks: created });
  }));

  // GET /api/tasks/:id/status — lightweight polling endpoint
  router.get('/:id/status', asyncHandler(async (req: Request, res: Response) => {
    const task = await repo.getById(paramId(req));
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    res.json({
      id: task.id,
      agentStatus: task.agentStatus,
      agentType: task.agentType,
      columnId: task.columnId,
      isRunning: agentManager.isRunning(task.id),
    });
  }));

  // PATCH /api/tasks/:id
  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const task = await repo.getById(paramId(req));
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }

    const taskProjectId = task.projectId ?? 'default';
    if (req.body.projectId !== undefined && req.body.projectId !== taskProjectId) {
      res.status(400).json({ error: 'projectId is immutable' });
      return;
    }

    const taskProject = await projectRepo.getById(taskProjectId);
    if (!taskProject) {
      res.status(400).json({ error: 'task project not found' });
      return;
    }

    const { title, description, priority, columnId, agentStatus, agentType, repoPath, branchName, baseBranch, useWorktree, archived, timeoutMinutes } = req.body;

    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      res.status(400).json({ error: 'title must be a non-empty string' });
      return;
    }
    if (typeof title === 'string' && title.length > MAX_TITLE_LENGTH) {
      res.status(400).json({ error: `title must be at most ${MAX_TITLE_LENGTH} characters` });
      return;
    }
    if (description !== undefined && typeof description !== 'string') {
      res.status(400).json({ error: 'description must be a string' });
      return;
    }
    if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
      res.status(400).json({ error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` });
      return;
    }
    if (priority !== undefined && !isValidPriority(priority)) {
      res.status(400).json({ error: 'invalid priority: must be one of low, medium, high, critical' });
      return;
    }
    if (columnId !== undefined && !isValidColumnId(columnId)) {
      res.status(400).json({ error: 'invalid columnId: must be one of backlog, in-progress, review, done' });
      return;
    }
    if (agentStatus !== undefined && !isValidAgentStatus(agentStatus)) {
      res.status(400).json({ error: 'invalid agentStatus: must be one of idle, planning, executing, complete, failed' });
      return;
    }
    if (agentType !== undefined && !isValidAgentType(agentType)) {
      res.status(400).json({ error: `invalid agentType: must be one of ${VALID_AGENT_TYPES.join(', ')}` });
      return;
    }
    if (timeoutMinutes !== undefined && timeoutMinutes !== null && !isValidAgentTimeoutMinutes(timeoutMinutes)) {
      res.status(400).json({ error: `timeoutMinutes must be an integer between ${MIN_AGENT_TIMEOUT_MINUTES} and ${MAX_AGENT_TIMEOUT_MINUTES}` });
      return;
    }
    if (repoPath !== undefined && typeof repoPath !== 'string') {
      res.status(400).json({ error: 'repoPath must be a string' });
      return;
    }
    if (typeof repoPath === 'string') {
      if (taskProject.repoPath && normalizeRepoPathForCompare(repoPath) !== normalizeRepoPathForCompare(taskProject.repoPath)) {
        res.status(400).json({ error: 'repoPath is locked by the task project' });
        return;
      }
      const expandedRepoPath = expandTilde(repoPath);
      if (!path.isAbsolute(expandedRepoPath)) {
        res.status(400).json({ error: 'repoPath must be an absolute path' });
        return;
      }
      const repoErr = isAllowedRepoPath(expandedRepoPath);
      if (repoErr) {
        res.status(400).json({ error: repoErr });
        return;
      }
    }

    // Validate column transition if columnId is changing
    if (columnId && columnId !== task.columnId) {
      const allowed = VALID_TRANSITIONS[task.columnId];
      if (!allowed.includes(columnId)) {
        res.status(400).json({ error: `Cannot move from ${task.columnId} to ${columnId}` });
        return;
      }
    }

    // Build updates from validated fields
    const updates: Partial<Task> = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (priority !== undefined) updates.priority = priority;
    if (columnId !== undefined) updates.columnId = columnId;
    if (agentStatus !== undefined) updates.agentStatus = agentStatus;
    if (agentType !== undefined) updates.agentType = agentType;
    if (repoPath !== undefined && !taskProject.repoPath) updates.repoPath = typeof repoPath === 'string' ? expandTilde(repoPath) : repoPath;
    if (branchName !== undefined) updates.branchName = branchName || undefined;
    if (baseBranch !== undefined) updates.baseBranch = baseBranch;
    if (useWorktree !== undefined) updates.useWorktree = Boolean(useWorktree);
    if (archived !== undefined) updates.archived = Boolean(archived);
    if (timeoutMinutes !== undefined) updates.timeoutMinutes = timeoutMinutes;

    // Reset agent state when moved to in-progress
    if (columnId === 'in-progress') {
      updates.agentStatus = 'idle';
      updates.startedAt = undefined;
      updates.completedAt = undefined;
    }

    const updated = await repo.update(task.id, updates);
    if (!updated) {
      res.status(500).json({ error: 'failed to update task' });
      return;
    }
    broadcastTaskUpdate(updated);
    res.json(updated);
  }));

  // DELETE /api/tasks/:id
  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    if (!await repo.getById(id)) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    agentManager.stopAgent(id);
    agentManager.clearEvents(id);
    await repo.deleteEventsByTaskId(id);
    await repo.delete(id);
    broadcast({ type: 'task_deleted', payload: { id } });
    res.status(204).send();
  }));

  // PATCH /api/tasks/:id/archive
  router.patch('/:id/archive', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (task.columnId !== 'done' && task.agentStatus !== 'failed') {
      res.status(400).json({ error: 'can only archive completed or failed tasks' });
      return;
    }
    const updated = await repo.update(id, { archived: true });
    if (!updated) {
      res.status(500).json({ error: 'failed to archive task' });
      return;
    }
    broadcastTaskUpdate(updated);
    res.json(updated);
  }));

  // PATCH /api/tasks/:id/unarchive
  router.patch('/:id/unarchive', asyncHandler(async (req: Request, res: Response) => {
    const id = paramId(req);
    const task = await repo.getById(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!task.archived) {
      res.status(400).json({ error: 'task is not archived' });
      return;
    }
    const updated = await repo.update(id, { archived: false });
    if (!updated) {
      res.status(500).json({ error: 'failed to unarchive task' });
      return;
    }
    broadcastTaskUpdate(updated);
    res.json(updated);
  }));

  return router;
}

function sanitizeProvenance(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const allowed = ['sourceProfile','sourcePlatform','sourceSession','sourceMessage','requestedBy','origin'];
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k,v]) => allowed.includes(k) && (k === 'origin' ? !!v && typeof v === 'object' : typeof v === 'string')));
}

async function getProjectForRequest(projectRepo: ProjectRepository, value: unknown): Promise<Project | undefined> {
  if (typeof value === 'string' && value) return projectRepo.getById(value);
  return projectRepo.getDefault();
}

function enforceProjectRepoPath(body: Record<string, any>, project: Project): Record<string, any> | string {
  if (!project.repoPath) return { ...body, projectId: project.id };
  if (
    body.repoPath !== undefined
    && (typeof body.repoPath !== 'string' || normalizeRepoPathForCompare(body.repoPath) !== normalizeRepoPathForCompare(project.repoPath))
  ) {
    return 'repoPath must match the selected project';
  }
  return { ...body, projectId: project.id, repoPath: project.repoPath };
}

/**
 * Fill task fields left undefined by the request with the project's configured defaults.
 * Each field remains overridable: an explicit value (including `useWorktree: false`) is
 * preserved. Applied at create time only — editing a task never re-applies defaults.
 */
function applyProjectDefaults(body: Record<string, any>, project: Project): Record<string, any> {
  const result = { ...body };
  if (result.agentType === undefined && project.defaultAgentType !== undefined) {
    result.agentType = project.defaultAgentType;
  }
  if (result.priority === undefined && project.defaultPriority !== undefined) {
    result.priority = project.defaultPriority;
  }
  if (result.baseBranch === undefined && project.defaultBaseBranch !== undefined) {
    result.baseBranch = project.defaultBaseBranch;
  }
  if (result.useWorktree === undefined && project.defaultUseWorktree !== undefined) {
    result.useWorktree = project.defaultUseWorktree;
  }
  return result;
}
