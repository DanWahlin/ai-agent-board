import { Router, Request, Response } from 'express';
import crypto from 'crypto';
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
  VOICE_CLAIM_MIN_TTL_MS,
  VOICE_CLAIM_MAX_TTL_MS,
  MAX_PROVIDER_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_SESSION_ID_LENGTH,
  MAX_CAPABILITIES_LENGTH,
  MAX_END_REASON_LENGTH,
  MAX_MESSAGE_ID_LENGTH,
  MAX_ATTEMPT_ID_LENGTH,
  MAX_SEARCH_QUERY_LENGTH,
} from '@ai-agent-board/shared/constants.js';

const ALLOWED_PATCH_FIELDS = new Set(['title', 'state', 'preferredProjectId']);

function requirePrincipal(req: Request, res: Response): string | null {
  const principalId = extractPrincipalId(req);
  if (!principalId || typeof principalId !== 'string' || principalId.length === 0 || principalId.length > 128) {
    res.status(400).json({ error: 'MISSING_PRINCIPAL', message: 'X-Principal-Id header is required' });
    return null;
  }
  return principalId;
}

function parsePositiveInt(value: unknown, field: string, res: Response, max?: number): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    res.status(400).json({ error: 'INVALID_PARAMETER', message: `${field} must be a positive integer` });
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    res.status(400).json({ error: 'INVALID_PARAMETER', message: `${field} must be a positive integer${max !== undefined ? ` <= ${max}` : ''}` });
    return null;
  }
  return parsed;
}

function computeRequestHash(title: string, preferredProjectId?: string): string {
  const canonical = JSON.stringify({ title, preferredProjectId: preferredProjectId ?? null });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

export function createConversationsRouter(
  convRepo: ConversationRepository,
  taskRepo: TaskRepository,
): Router {
  const router = Router();

  // POST / — Create conversation
  router.post('/', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const { title, preferredProjectId } = req.body ?? {};
    if (!title || typeof title !== 'string' || title.length === 0 || title.length > MAX_CONVERSATION_TITLE_LENGTH) {
      res.status(400).json({ error: 'INVALID_TITLE', message: `title is required and must be <= ${MAX_CONVERSATION_TITLE_LENGTH} characters` });
      return;
    }
    if (preferredProjectId !== undefined && typeof preferredProjectId !== 'string') {
      res.status(400).json({ error: 'INVALID_PARAMETER', message: 'preferredProjectId must be a string' });
      return;
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 256)) {
      res.status(400).json({ error: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be a non-empty string <= 256 characters' });
      return;
    }

    const requestHash = idempotencyKey ? computeRequestHash(title, preferredProjectId) : undefined;
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

    const result = await convRepo.create(conversation, idempotencyKey, requestHash);
    if (result.conflict === 'IDEMPOTENCY_PAYLOAD_CONFLICT') {
      res.status(409).json({ error: 'IDEMPOTENCY_PAYLOAD_CONFLICT', message: 'Idempotency key reused with different payload' });
      return;
    }
    res.status(result.created ? 201 : 200).json(result.conversation);
  }));

  // GET / — List conversations
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (state && !isValidConversationState(state)) {
      res.status(400).json({ error: 'INVALID_STATE', message: 'invalid state filter' });
      return;
    }

    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = parsePositiveInt(req.query.limit, 'limit', res, MAX_CONVERSATIONS_PAGE_SIZE);
    if (limit === null) return;

    const page = await convRepo.list(principalId, { state, cursor, limit });
    res.json(page);
  }));

  // GET /search — Search conversations by title/message text
  router.get('/search', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q || q.length > MAX_SEARCH_QUERY_LENGTH) {
      res.status(400).json({ error: 'INVALID_QUERY', message: `q is required and must be <= ${MAX_SEARCH_QUERY_LENGTH} characters` });
      return;
    }

    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const limit = parsePositiveInt(req.query.limit, 'limit', res, MAX_CONVERSATIONS_PAGE_SIZE);
    if (limit === null) return;

    const result = await convRepo.search(principalId, q, { cursor, limit });
    res.json(result);
  }));

  // GET /:id — Get conversation
  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const conv = await convRepo.getById(paramId(req), principalId);
    if (!conv) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'not found' });
      return;
    }
    res.json(conv);
  }));

  // PATCH /:id — Update conversation
  router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    // Reject unknown fields
    const bodyKeys = Object.keys(req.body ?? {});
    const unknownFields = bodyKeys.filter(k => !ALLOWED_PATCH_FIELDS.has(k));
    if (unknownFields.length > 0) {
      res.status(400).json({ error: 'UNKNOWN_FIELDS', message: `Unknown fields: ${unknownFields.join(', ')}` });
      return;
    }

    const ifMatch = req.headers['if-match'];
    if (!ifMatch) {
      res.status(428).json({ error: 'PRECONDITION_REQUIRED', message: 'If-Match header required' });
      return;
    }
    const revision = Number.parseInt(ifMatch as string, 10);
    if (!Number.isInteger(revision)) {
      res.status(400).json({ error: 'INVALID_REVISION', message: 'If-Match must be a revision number' });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== 'string' || req.body.title.length === 0 || req.body.title.length > MAX_CONVERSATION_TITLE_LENGTH) {
        res.status(400).json({ error: 'INVALID_TITLE', message: 'invalid title' });
        return;
      }
      updates.title = req.body.title;
    }
    if (req.body.state !== undefined) {
      if (!isValidConversationState(req.body.state) || req.body.state === 'deleted' || req.body.state === 'deleting') {
        res.status(400).json({ error: 'INVALID_STATE_TRANSITION', message: 'invalid state transition' });
        return;
      }
      updates.state = req.body.state;
    }
    if (req.body.preferredProjectId !== undefined && typeof req.body.preferredProjectId !== 'string') {
      res.status(400).json({ error: 'INVALID_PARAMETER', message: 'preferredProjectId must be a string' });
      return;
    }
    if (req.body.preferredProjectId !== undefined) {
      updates.preferredProjectId = req.body.preferredProjectId;
    }

    const result = await convRepo.update(paramId(req), principalId, revision, updates);
    if (!result) {
      // Uniform 404 for cross-principal or not found; 409 only for same-principal revision mismatch
      // We can't distinguish here without an extra query, so return 409 (the route is principal-scoped)
      res.status(409).json({ error: 'CONFLICT', message: 'revision conflict or not found' });
      return;
    }
    res.json(result);
  }));

  // DELETE /:id — Delete conversation
  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const ifMatch = req.headers['if-match'];
    if (!ifMatch) {
      res.status(428).json({ error: 'PRECONDITION_REQUIRED', message: 'If-Match header required' });
      return;
    }
    const revision = Number.parseInt(ifMatch as string, 10);
    if (!Number.isInteger(revision)) {
      res.status(400).json({ error: 'INVALID_REVISION', message: 'If-Match must be a revision number' });
      return;
    }

    const result = await convRepo.delete(paramId(req), principalId, revision);
    if (result === 'not_found') {
      res.status(404).json({ error: 'NOT_FOUND', message: 'not found' });
      return;
    }
    if (result === 'revision_conflict') {
      res.status(409).json({ error: 'REVISION_CONFLICT', message: 'revision conflict' });
      return;
    }
    res.status(204).end();
  }));

  // GET /:id/messages — List messages
  router.get('/:id/messages', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const conv = await convRepo.getById(paramId(req), principalId);
    if (!conv) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'not found' });
      return;
    }

    let afterSeq: number | undefined;
    if (req.query.afterSeq !== undefined) {
      if (typeof req.query.afterSeq !== 'string') {
        res.status(400).json({ error: 'INVALID_PARAMETER', message: 'afterSeq must be a non-negative integer' });
        return;
      }
      afterSeq = Number.parseInt(req.query.afterSeq, 10);
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        res.status(400).json({ error: 'INVALID_PARAMETER', message: 'afterSeq must be a non-negative integer' });
        return;
      }
    }

    const limit = parsePositiveInt(req.query.limit, 'limit', res, MAX_MESSAGES_PAGE_SIZE);
    if (limit === null) return;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const page = await convRepo.getMessages(paramId(req), principalId, { afterSeq, limit, cursor });
    res.json(page);
  }));

  // POST /:id/messages:append — Append messages (explicit action verb)
  // Also support POST /:id/messages for backward compatibility
  const appendHandler = asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const { epoch, messages } = req.body ?? {};
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) {
      res.status(400).json({ error: 'INVALID_EPOCH', message: 'epoch must be a positive integer' });
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES_PER_APPEND) {
      res.status(400).json({ error: 'INVALID_MESSAGES', message: `messages must be an array of 1-${MAX_MESSAGES_PER_APPEND} items` });
      return;
    }

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        res.status(400).json({ error: 'INVALID_MESSAGE', message: 'each message must be an object' });
        return;
      }
      if (!msg.id || typeof msg.id !== 'string') {
        res.status(400).json({ error: 'INVALID_MESSAGE', message: 'each message requires an id' });
        return;
      }
      if (!isValidConversationMessageRole(msg.role)) {
        res.status(400).json({ error: 'INVALID_MESSAGE', message: 'invalid message role' });
        return;
      }
      if (!isValidConversationMessageKind(msg.kind)) {
        res.status(400).json({ error: 'INVALID_MESSAGE', message: 'invalid message kind' });
        return;
      }
      if (typeof msg.text !== 'string' || msg.text.length === 0 || msg.text.length > MAX_CONVERSATION_MESSAGE_LENGTH) {
        res.status(400).json({ error: 'INVALID_MESSAGE', message: `message text must be 1-${MAX_CONVERSATION_MESSAGE_LENGTH} characters` });
        return;
      }
    }

    try {
      const result = await convRepo.appendMessages(paramId(req), principalId, epoch, messages);
      res.status(200).json(result);
    } catch (err: any) {
      if (err.message === 'CONVERSATION_NOT_ACTIVE') {
        res.status(404).json({ error: 'NOT_FOUND', message: 'conversation not active or not found' });
        return;
      }
      if (err.message === 'NO_VOICE_CLAIM') {
        res.status(409).json({ error: 'NO_VOICE_CLAIM', message: 'no active voice claim' });
        return;
      }
      if (err.message === 'STALE_EPOCH') {
        res.status(409).json({ error: 'STALE_EPOCH', message: 'stale epoch' });
        return;
      }
      if (err.message === 'CLAIM_EXPIRED') {
        res.status(409).json({ error: 'CLAIM_EXPIRED', message: 'voice claim expired' });
        return;
      }
      if (err.message === 'CLIENT_EVENT_CONFLICT') {
        res.status(409).json({ error: 'CLIENT_EVENT_CONFLICT', message: 'client event id replayed with different payload' });
        return;
      }
      throw err;
    }
  });
  router.post('/:id/messages\\:append', appendHandler);
  router.post('/:id/messages', appendHandler);

  // GET /:id/hydration — Get hydration payload
  router.get('/:id/hydration', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const result = await convRepo.getHydration(paramId(req), principalId);
    if (!result) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'not found' });
      return;
    }
    res.json(result);
  }));

  // POST /:id/voice-claims — Acquire voice claim
  router.post('/:id/voice-claims', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const conv = await convRepo.getById(paramId(req), principalId);
    if (!conv) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'not found' });
      return;
    }

    const { epoch } = req.body ?? {};
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) {
      res.status(400).json({ error: 'INVALID_EPOCH', message: 'epoch must be a positive integer' });
      return;
    }

    const ttlMs = req.body?.ttlMs ?? VOICE_CLAIM_TTL_MS;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < VOICE_CLAIM_MIN_TTL_MS || ttlMs > VOICE_CLAIM_MAX_TTL_MS) {
      res.status(400).json({ error: 'INVALID_TTL', message: `ttlMs must be between ${VOICE_CLAIM_MIN_TTL_MS} and ${VOICE_CLAIM_MAX_TTL_MS}` });
      return;
    }

    const claim = await convRepo.acquireVoiceClaim(paramId(req), principalId, epoch, ttlMs);
    if (!claim) {
      res.status(409).json({ error: 'CLAIM_DENIED', message: 'could not acquire voice claim' });
      return;
    }
    res.status(200).json(claim);
  }));

  // DELETE /:id/voice-claims/:epoch — Release voice claim
  router.delete('/:id/voice-claims/:epoch', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const epoch = Number.parseInt(req.params.epoch as string, 10);
    if (!Number.isInteger(epoch)) {
      res.status(400).json({ error: 'INVALID_EPOCH', message: 'invalid epoch' });
      return;
    }

    const released = await convRepo.releaseVoiceClaim(paramId(req), principalId, epoch);
    if (!released) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'claim not found' });
      return;
    }
    res.status(204).end();
  }));

  // POST /:id/provider-sessions — Begin provider session
  router.post('/:id/provider-sessions', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const { epoch, provider, model, sessionId, capabilities, expiresAt } = req.body ?? {};
    if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) {
      res.status(400).json({ error: 'INVALID_EPOCH', message: 'epoch is required' });
      return;
    }
    if (!provider || typeof provider !== 'string' || provider.length > MAX_PROVIDER_LENGTH) {
      res.status(400).json({ error: 'INVALID_PROVIDER', message: `provider is required and must be <= ${MAX_PROVIDER_LENGTH} characters` });
      return;
    }
    if (model !== undefined && (typeof model !== 'string' || model.length > MAX_MODEL_LENGTH)) {
      res.status(400).json({ error: 'INVALID_MODEL', message: `model must be a string <= ${MAX_MODEL_LENGTH} characters` });
      return;
    }
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > MAX_SESSION_ID_LENGTH)) {
      res.status(400).json({ error: 'INVALID_SESSION_ID', message: `sessionId must be a string <= ${MAX_SESSION_ID_LENGTH} characters` });
      return;
    }
    if (capabilities !== undefined && (typeof capabilities !== 'string' || capabilities.length > MAX_CAPABILITIES_LENGTH)) {
      res.status(400).json({ error: 'INVALID_CAPABILITIES', message: `capabilities must be a string <= ${MAX_CAPABILITIES_LENGTH} characters` });
      return;
    }
    if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
      res.status(400).json({ error: 'INVALID_PARAMETER', message: 'expiresAt must be a number' });
      return;
    }

    try {
      const session = await convRepo.beginProviderSession(paramId(req), principalId, epoch, {
        provider,
        model,
        sessionId,
        capabilities,
        startedAt: Date.now(),
        expiresAt,
      });
      res.status(201).json(session);
    } catch (err: any) {
      if (err.message === 'CONVERSATION_NOT_ACTIVE') {
        res.status(404).json({ error: 'NOT_FOUND', message: 'not found' });
        return;
      }
      if (err.message === 'NO_VOICE_CLAIM') {
        res.status(409).json({ error: 'NO_VOICE_CLAIM', message: 'no active voice claim for this epoch' });
        return;
      }
      if (err.message === 'CLAIM_EXPIRED') {
        res.status(409).json({ error: 'CLAIM_EXPIRED', message: 'voice claim expired' });
        return;
      }
      throw err;
    }
  }));

  // POST /:id/provider-sessions/:epoch/finish — Finish provider session
  router.post('/:id/provider-sessions/:epoch/finish', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const epoch = Number.parseInt(req.params.epoch as string, 10);
    if (!Number.isInteger(epoch)) {
      res.status(400).json({ error: 'INVALID_EPOCH', message: 'invalid epoch' });
      return;
    }

    const endReason = req.body?.endReason;
    if (endReason !== undefined && (typeof endReason !== 'string' || endReason.length > MAX_END_REASON_LENGTH)) {
      res.status(400).json({ error: 'INVALID_END_REASON', message: `endReason must be a string <= ${MAX_END_REASON_LENGTH} characters` });
      return;
    }

    const finished = await convRepo.finishProviderSession(paramId(req), principalId, epoch, Date.now(), endReason ?? 'normal');
    if (!finished) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'session not found or already finished' });
      return;
    }
    res.status(200).json({ ok: true });
  }));

  // GET /:id/tasks — Get linked tasks
  router.get('/:id/tasks', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const conv = await convRepo.getById(paramId(req), principalId);
    if (!conv) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'not found' });
      return;
    }

    const links = await convRepo.getLinkedTasks(paramId(req), principalId);
    res.json(links);
  }));

  // POST /:id/tasks — Link task to conversation
  router.post('/:id/tasks', asyncHandler(async (req: Request, res: Response) => {
    const principalId = requirePrincipal(req, res);
    if (!principalId) return;

    const conv = await convRepo.getById(paramId(req), principalId);
    if (!conv) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'not found' });
      return;
    }

    const { taskId, messageId, attemptId } = req.body ?? {};
    if (!taskId || typeof taskId !== 'string') {
      res.status(400).json({ error: 'INVALID_TASK_ID', message: 'taskId is required' });
      return;
    }
    if (messageId !== undefined && (typeof messageId !== 'string' || messageId.length > MAX_MESSAGE_ID_LENGTH)) {
      res.status(400).json({ error: 'INVALID_MESSAGE_ID', message: `messageId must be a string <= ${MAX_MESSAGE_ID_LENGTH} characters` });
      return;
    }
    if (attemptId !== undefined && (typeof attemptId !== 'string' || attemptId.length > MAX_ATTEMPT_ID_LENGTH)) {
      res.status(400).json({ error: 'INVALID_ATTEMPT_ID', message: `attemptId must be a string <= ${MAX_ATTEMPT_ID_LENGTH} characters` });
      return;
    }

    const task = await taskRepo.getById(taskId);
    if (!task) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'task not found' });
      return;
    }
    if (attemptId !== undefined) {
      const attempt = await taskRepo.getAttemptById(attemptId);
      if (!attempt || attempt.taskId !== taskId) {
        res.status(400).json({ error: 'INVALID_ATTEMPT_ID', message: 'attemptId does not belong to taskId' });
        return;
      }
      const latestAttempt = (await taskRepo.getAttemptsByTaskId(taskId)).at(-1);
      if (!latestAttempt || latestAttempt.id !== attemptId) {
        res.status(409).json({ error: 'STALE_ATTEMPT_ID', message: 'attemptId is not the current task attempt' });
        return;
      }
    }

    try {
      const result = await convRepo.linkTask(paramId(req), principalId, {
        conversationId: paramId(req),
        taskId,
        messageId,
        attemptId,
        createdAt: Date.now(),
      });
      res.status(result.created ? 201 : 200).json(result.link);
    } catch (err: any) {
      if (err.message === 'CONVERSATION_NOT_ACTIVE') {
        res.status(404).json({ error: 'NOT_FOUND', message: 'not found' });
        return;
      }
      if (err.message === 'TASK_LINK_CONFLICT') {
        res.status(409).json({ error: 'TASK_LINK_CONFLICT', message: 'task link is bound to a different message' });
        return;
      }
      throw err;
    }
  }));

  return router;
}
