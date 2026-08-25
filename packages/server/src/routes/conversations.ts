import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { ConversationRepository } from '../repositories/conversation-types.js';
import type { TaskRepository } from '../repositories/types.js';
import { asyncHandler, paramId } from './helpers.js';
import { extractPrincipalId } from '../middleware/auth.js';
import {
  isValidConversationState,
  isValidConversationMessageRole,
  isValidConversationMessageKind,
  MAX_CONVERSATION_TITLE_LENGTH,
  MAX_CONVERSATION_MESSAGE_LENGTH,
  MAX_MESSAGES_PER_APPEND,
  MAX_CONVERSATIONS_PAGE_SIZE,
  MAX_MESSAGES_PAGE_SIZE,
  VOICE_CLAIM_TTL_MS,
} from '@ai-agent-board/shared/constants.js';

function requirePrincipal(req: Request, res: Response): string | null {
  const principalId = extractPrincipalId(req);
  if (!principalId || typeof principalId !== 'string' || principalId.length === 0 || principalId.length > 128) {
    res.status(400).json({ error: 'X-Principal-Id header is required' });
    return null;
  }
  return principalId;
}

function parsePositiveInt(value: unknown, field: string, res: Response, max?: number): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    res.status(400).json({ error: `${field} must be a positive integer` });
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    res.status(400).json({ error: `${field} must be a positive integer${max !== undefined ? ` <= ${max}` : ''}` });
    return null;
  }
  return parsed;
}

function paramValue(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : value?.[0] ?? '';
}

async function requireConversation(convRepo: ConversationRepository, id: string, principalId: string, res: Response) {
  const conv = await convRepo.getById(id, principalId);
  if (!conv) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return conv;
}

export function createConversationsRouter(
  convRepo: ConversationRepository,
  taskRepo: TaskRepository,
): Router {
  const router = Router();

  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const { title, preferredProjectId } = req.body ?? {};
    if (!title || typeof title !== 'string' || title.length === 0 || title.length > MAX_CONVERSATION_TITLE_LENGTH) {
      res.status(400).json({ error: `title is required and must be <= ${MAX_CONVERSATION_TITLE_LENGTH} characters` });
      return;
    }
    if (preferredProjectId !== undefined && typeof preferredProjectId !== 'string') {
      res.status(400).json({ error: 'preferredProjectId must be a string' });
      return;
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 256)) {
      res.status(400).json({ error: 'Idempotency-Key must be a non-empty string <= 256 characters' });
      return;
    }

    const now = Date.now();
    const conversation = {
      id: uuid(),
      principalId,
      title,
      state: 'active' as const,
      preferredProjectId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    const result = await convRepo.create(conversation, idempotencyKey);
    res.status(result.created ? 201 : 200).json(result.conversation);
  }));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (state && !isValidConversationState(state)) {
      res.status(400).json({ error: 'invalid state filter' });
      return;
    }

    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = parsePositiveInt(req.query.limit, 'limit', res, MAX_CONVERSATIONS_PAGE_SIZE);
    if (limit === null) return;

    const page = await convRepo.list(principalId, { state, cursor, limit });
    res.json(page);
  }));

  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const conv = await convRepo.getById(paramId(req), principalId);
    if (!conv) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(conv);
  }));

  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const ifMatch = req.headers['if-match'];
    if (!ifMatch) {
      res.status(428).json({ error: 'If-Match header required' });
      return;
    }
    const revision = Number.parseInt(ifMatch as string, 10);
    if (!Number.isInteger(revision)) {
      res.status(400).json({ error: 'If-Match must be a revision number' });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== 'string' || req.body.title.length === 0 || req.body.title.length > MAX_CONVERSATION_TITLE_LENGTH) {
        res.status(400).json({ error: 'invalid title' });
        return;
      }
      updates.title = req.body.title;
    }
    if (req.body.state !== undefined) {
      if (!isValidConversationState(req.body.state) || req.body.state === 'deleted' || req.body.state === 'deleting') {
        res.status(400).json({ error: 'invalid state transition' });
        return;
      }
      updates.state = req.body.state;
    }
    if (req.body.preferredProjectId !== undefined && typeof req.body.preferredProjectId !== 'string') {
      res.status(400).json({ error: 'preferredProjectId must be a string' });
      return;
    }
    if (req.body.preferredProjectId !== undefined) {
      updates.preferredProjectId = req.body.preferredProjectId;
    }

    const result = await convRepo.update(paramId(req), principalId, revision, updates);
    if (!result) {
      res.status(409).json({ error: 'conflict or not found' });
      return;
    }
    res.json(result);
  }));

  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const ifMatch = req.headers['if-match'];
    if (!ifMatch) {
      res.status(428).json({ error: 'If-Match header required' });
      return;
    }
    const revision = Number.parseInt(ifMatch as string, 10);
    if (!Number.isInteger(revision)) {
      res.status(400).json({ error: 'If-Match must be a revision number' });
      return;
    }

    const result = await convRepo.delete(paramId(req), principalId, revision);
    if (!result) {
      res.status(404).json({ error: 'not found or already deleted' });
      return;
    }
    res.status(204).end();
  }));

  router.get('/:id/messages', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;
    if (!await requireConversation(convRepo, paramId(req), principalId, res)) return;

    let afterSeq: number | undefined;
    if (req.query.afterSeq !== undefined) {
      if (typeof req.query.afterSeq !== 'string') {
        res.status(400).json({ error: 'afterSeq must be a non-negative integer' });
        return;
      }
      afterSeq = Number.parseInt(req.query.afterSeq, 10);
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        res.status(400).json({ error: 'afterSeq must be a non-negative integer' });
        return;
      }
    }

    const limit = parsePositiveInt(req.query.limit, 'limit', res, MAX_MESSAGES_PAGE_SIZE);
    if (limit === null) return;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const page = await convRepo.getMessages(paramId(req), principalId, { afterSeq, limit, cursor });
    res.json(page);
  }));

  router.post('/:id/messages', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const { epoch, messages } = req.body ?? {};
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) {
      res.status(400).json({ error: 'epoch must be a non-negative integer' });
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES_PER_APPEND) {
      res.status(400).json({ error: `messages must be an array of 1-${MAX_MESSAGES_PER_APPEND} items` });
      return;
    }

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        res.status(400).json({ error: 'each message must be an object' });
        return;
      }
      if (!msg.id || typeof msg.id !== 'string') {
        res.status(400).json({ error: 'each message requires an id' });
        return;
      }
      if (!isValidConversationMessageRole(msg.role)) {
        res.status(400).json({ error: 'invalid message role' });
        return;
      }
      if (!isValidConversationMessageKind(msg.kind)) {
        res.status(400).json({ error: 'invalid message kind' });
        return;
      }
      if (typeof msg.text !== 'string' || msg.text.length === 0 || msg.text.length > MAX_CONVERSATION_MESSAGE_LENGTH) {
        res.status(400).json({ error: `message text must be 1-${MAX_CONVERSATION_MESSAGE_LENGTH} characters` });
        return;
      }
    }

    try {
      const result = await convRepo.appendMessages(paramId(req), principalId, epoch, messages);
      res.status(200).json(result);
    } catch (err: any) {
      if (err.message === 'CONVERSATION_NOT_ACTIVE') {
        res.status(404).json({ error: 'conversation not active or not found' });
        return;
      }
      if (err.message === 'STALE_EPOCH') {
        res.status(409).json({ error: 'stale epoch' });
        return;
      }
      if (err.message === 'CLAIM_EXPIRED') {
        res.status(409).json({ error: 'voice claim expired' });
        return;
      }
      throw err;
    }
  }));

  router.get('/:id/hydration', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const result = await convRepo.getHydration(paramId(req), principalId);
    if (!result) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(result);
  }));

  router.post('/:id/voice-claims', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const conv = await requireConversation(convRepo, paramId(req), principalId, res);
    if (!conv) return;

    const { epoch } = req.body ?? {};
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) {
      res.status(400).json({ error: 'epoch must be a positive integer' });
      return;
    }

    const ttlMs = req.body?.ttlMs ?? VOICE_CLAIM_TTL_MS;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      res.status(400).json({ error: 'ttlMs must be a positive number' });
      return;
    }

    const claim = await convRepo.acquireVoiceClaim(paramId(req), principalId, epoch, ttlMs);
    if (!claim) {
      res.status(409).json({ error: 'could not acquire voice claim' });
      return;
    }
    res.status(200).json(claim);
  }));

  router.delete('/:id/voice-claims/:epoch', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const epoch = Number.parseInt(paramValue(req.params.epoch), 10);
    if (!Number.isInteger(epoch)) {
      res.status(400).json({ error: 'invalid epoch' });
      return;
    }

    const released = await convRepo.releaseVoiceClaim(paramId(req), principalId, epoch);
    if (!released) {
      res.status(404).json({ error: 'claim not found' });
      return;
    }
    res.status(204).end();
  }));

  router.post('/:id/provider-sessions', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const conv = await requireConversation(convRepo, paramId(req), principalId, res);
    if (!conv) return;

    const { epoch, provider, model, sessionId, capabilities, expiresAt } = req.body ?? {};
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) {
      res.status(400).json({ error: 'epoch is required' });
      return;
    }
    if (!provider || typeof provider !== 'string') {
      res.status(400).json({ error: 'provider is required' });
      return;
    }
    if (model !== undefined && typeof model !== 'string') {
      res.status(400).json({ error: 'model must be a string' });
      return;
    }
    if (sessionId !== undefined && typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId must be a string' });
      return;
    }
    if (capabilities !== undefined && typeof capabilities !== 'string') {
      res.status(400).json({ error: 'capabilities must be a string' });
      return;
    }
    if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
      res.status(400).json({ error: 'expiresAt must be a number' });
      return;
    }
    if (conv.state === 'deleted') {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const session = await convRepo.beginProviderSession({
      conversationId: paramId(req),
      epoch,
      provider,
      model,
      sessionId,
      capabilities,
      startedAt: Date.now(),
      expiresAt,
    });
    res.status(201).json(session);
  }));

  router.post('/:id/provider-sessions/:epoch/finish', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;
    if (!await requireConversation(convRepo, paramId(req), principalId, res)) return;

    const epoch = Number.parseInt(paramValue(req.params.epoch), 10);
    if (!Number.isInteger(epoch)) {
      res.status(400).json({ error: 'invalid epoch' });
      return;
    }

    const endReason = req.body?.endReason;
    if (endReason !== undefined && typeof endReason !== 'string') {
      res.status(400).json({ error: 'endReason must be a string' });
      return;
    }

    const finished = await convRepo.finishProviderSession(paramId(req), epoch, Date.now(), endReason ?? 'normal');
    if (!finished) {
      res.status(404).json({ error: 'session not found or already finished' });
      return;
    }
    res.status(200).json({ ok: true });
  }));

  router.get('/:id/tasks', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;
    if (!await requireConversation(convRepo, paramId(req), principalId, res)) return;

    const links = await convRepo.getLinkedTasks(paramId(req), principalId);
    res.json(links);
  }));

  router.post('/:id/tasks', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const conv = await requireConversation(convRepo, paramId(req), principalId, res);
    if (!conv) return;

    const { taskId, messageId, attemptId } = req.body ?? {};
    if (!taskId || typeof taskId !== 'string') {
      res.status(400).json({ error: 'taskId is required' });
      return;
    }
    if (messageId !== undefined && typeof messageId !== 'string') {
      res.status(400).json({ error: 'messageId must be a string' });
      return;
    }
    if (attemptId !== undefined && typeof attemptId !== 'string') {
      res.status(400).json({ error: 'attemptId must be a string' });
      return;
    }

    const task = await taskRepo.getById(taskId);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (conv.state === 'deleted') {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const result = await convRepo.linkTask({
      conversationId: paramId(req),
      taskId,
      messageId,
      attemptId,
      createdAt: Date.now(),
    });
    res.status(result.created ? 201 : 200).json(result.link);
  }));

  return router;
}
