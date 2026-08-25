import type { Pool } from 'pg';
import type {
  ConversationRepository,
  ConversationPage,
  MessagePage,
  AppendResult,
  HydrationResult,
  SearchResult,
  DeleteResult,
  CreateConflict,
} from './conversation-types.js';
import type {
  Conversation,
  ConversationMessage,
  ConversationSummary,
  ConversationProviderSession,
  ConversationTaskLink,
  ConversationVoiceClaim,
} from '../types.js';
import {
  MAX_MESSAGES_PAGE_SIZE,
  DEFAULT_MESSAGES_PAGE_SIZE,
  MAX_CONVERSATIONS_PAGE_SIZE,
  DEFAULT_CONVERSATIONS_PAGE_SIZE,
  MAX_HYDRATION_TURNS,
  MAX_HYDRATION_CHAR_PER_MSG,
  MAX_HYDRATION_TOTAL_BYTES,
  VOICE_CLAIM_MAX_TTL_MS,
} from '@ai-agent-board/shared/constants.js';

function encodeConversationCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

function decodeConversationCursor(cursor: string): { createdAt: number; id: string } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt) && typeof parsed.id === 'string' && parsed.id) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch { /* ignore */ }
  return undefined;
}

function decodeSeqCursor(cursor: string): number | undefined {
  try {
    const decoded = Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10);
    return Number.isInteger(decoded) && decoded >= 0 ? decoded : undefined;
  } catch { return undefined; }
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private pool: Pool) {}

  private rowToConversation(row: any): Conversation {
    return {
      id: row.id,
      principalId: row.principal_id,
      title: row.title,
      state: row.state,
      preferredProjectId: row.preferred_project_id ?? undefined,
      revision: row.revision,
      requestHash: row.request_hash ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      archivedAt: row.archived_at != null ? Number(row.archived_at) : undefined,
      deletedAt: row.deleted_at != null ? Number(row.deleted_at) : undefined,
    };
  }

  private rowToMessage(row: any): ConversationMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      seq: row.seq,
      role: row.role,
      kind: row.kind,
      text: row.text,
      clientEventId: row.client_event_id ?? undefined,
      providerType: row.provider_type ?? undefined,
      providerModel: row.provider_model ?? undefined,
      providerSessionId: row.provider_session_id ?? undefined,
      providerEpoch: row.provider_epoch != null ? Number(row.provider_epoch) : undefined,
      providerResponseId: row.provider_response_id ?? undefined,
      createdAt: Number(row.created_at),
    };
  }

  private rowToSummary(row: any): ConversationSummary {
    return {
      conversationId: row.conversation_id,
      version: row.version,
      throughSeq: row.through_seq,
      text: row.text,
      model: row.model ?? undefined,
      policy: row.policy ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToProviderSession(row: any): ConversationProviderSession {
    return {
      conversationId: row.conversation_id,
      epoch: row.epoch,
      provider: row.provider,
      model: row.model ?? undefined,
      sessionId: row.session_id ?? undefined,
      capabilities: row.capabilities ?? undefined,
      startedAt: Number(row.started_at),
      endedAt: row.ended_at != null ? Number(row.ended_at) : undefined,
      expiresAt: row.expires_at != null ? Number(row.expires_at) : undefined,
      endReason: row.end_reason ?? undefined,
    };
  }

  private rowToTaskLink(row: any): ConversationTaskLink {
    return {
      conversationId: row.conversation_id,
      taskId: row.task_id,
      messageId: row.message_id ?? undefined,
      attemptId: row.attempt_id ?? undefined,
      createdAt: Number(row.created_at),
    };
  }

  private rowToVoiceClaim(row: any): ConversationVoiceClaim {
    return {
      conversationId: row.conversation_id,
      principalId: row.principal_id,
      epoch: row.epoch,
      claimedAt: Number(row.claimed_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async create(
    conversation: Conversation,
    idempotencyKey?: string,
    requestHash?: string,
  ): Promise<{ conversation: Conversation; created: boolean; conflict?: CreateConflict }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (idempotencyKey) {
        const { rows } = await client.query(
          'SELECT * FROM conversations WHERE idempotency_key = $1 AND principal_id = $2 FOR SHARE',
          [idempotencyKey, conversation.principalId],
        );
        if (rows.length > 0) {
          await client.query('COMMIT');
          const existing = this.rowToConversation(rows[0]);
          if (requestHash && rows[0].request_hash && rows[0].request_hash !== requestHash) {
            return { conversation: existing, created: false, conflict: 'IDEMPOTENCY_PAYLOAD_CONFLICT' };
          }
          return { conversation: existing, created: false };
        }
      }

      await client.query(`
        INSERT INTO conversations (id, principal_id, title, state, preferred_project_id, revision, request_hash, created_at, updated_at, idempotency_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        conversation.id,
        conversation.principalId,
        conversation.title,
        conversation.state,
        conversation.preferredProjectId ?? null,
        conversation.revision,
        requestHash ?? null,
        conversation.createdAt,
        conversation.updatedAt,
        idempotencyKey ?? null,
      ]);

      await client.query('COMMIT');
      return { conversation: { ...conversation, requestHash }, created: true };
    } catch (err: any) {
      await client.query('ROLLBACK');
      // Handle unique constraint violation on idempotency key (race condition)
      if (err.code === '23505' && err.constraint?.includes('idempotency')) {
        const { rows } = await this.pool.query(
          'SELECT * FROM conversations WHERE idempotency_key = $1 AND principal_id = $2',
          [idempotencyKey, conversation.principalId],
        );
        if (rows.length > 0) {
          const existing = this.rowToConversation(rows[0]);
          if (requestHash && rows[0].request_hash && rows[0].request_hash !== requestHash) {
            return { conversation: existing, created: false, conflict: 'IDEMPOTENCY_PAYLOAD_CONFLICT' };
          }
          return { conversation: existing, created: false };
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getById(id: string, principalId: string): Promise<Conversation | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND principal_id = $2 AND state != $3',
      [id, principalId, 'deleted'],
    );
    return rows.length > 0 ? this.rowToConversation(rows[0]) : undefined;
  }

  async list(principalId: string, options: { state?: string; cursor?: string; limit?: number }): Promise<ConversationPage> {
    const limit = Math.min(options.limit ?? DEFAULT_CONVERSATIONS_PAGE_SIZE, MAX_CONVERSATIONS_PAGE_SIZE);
    let query = 'SELECT * FROM conversations WHERE principal_id = $1 AND state != $2';
    const params: any[] = [principalId, 'deleted'];
    let paramIdx = 3;

    if (options.state) {
      query += ` AND state = $${paramIdx++}`;
      params.push(options.state);
    }

    const cursor = options.cursor ? decodeConversationCursor(options.cursor) : undefined;
    if (cursor) {
      query += ` AND (created_at < $${paramIdx} OR (created_at = $${paramIdx} AND id < $${paramIdx + 1}))`;
      params.push(cursor.createdAt, cursor.id);
      paramIdx += 2;
    }

    query += ` ORDER BY created_at DESC, id DESC LIMIT $${paramIdx}`;
    params.push(limit + 1);

    const { rows } = await this.pool.query(query, params);
    const hasMore = rows.length > limit;
    const conversations = rows.slice(0, limit).map((row: any) => this.rowToConversation(row));
    const nextCursor = hasMore && conversations.length > 0
      ? encodeConversationCursor(conversations[conversations.length - 1].createdAt, conversations[conversations.length - 1].id)
      : undefined;

    return { conversations, cursor: nextCursor, hasMore };
  }

  async search(principalId: string, query: string, options: { cursor?: string; limit?: number }): Promise<SearchResult> {
    const limit = Math.min(options.limit ?? DEFAULT_CONVERSATIONS_PAGE_SIZE, MAX_CONVERSATIONS_PAGE_SIZE);
    const pattern = `%${query}%`;
    let sql = `SELECT DISTINCT c.* FROM conversations c
      LEFT JOIN conversation_messages m ON m.conversation_id = c.id
      WHERE c.principal_id = $1 AND c.state != 'deleted'
        AND (c.title ILIKE $2 OR m.text ILIKE $3)`;
    const params: any[] = [principalId, pattern, pattern];
    let paramIdx = 4;

    const cursor = options.cursor ? decodeConversationCursor(options.cursor) : undefined;
    if (cursor) {
      sql += ` AND (c.created_at < $${paramIdx} OR (c.created_at = $${paramIdx} AND c.id < $${paramIdx + 1}))`;
      params.push(cursor.createdAt, cursor.id);
      paramIdx += 2;
    }

    sql += ` ORDER BY c.created_at DESC, c.id DESC LIMIT $${paramIdx}`;
    params.push(limit + 1);

    const { rows } = await this.pool.query(sql, params);
    const hasMore = rows.length > limit;
    const conversations = rows.slice(0, limit).map((row: any) => this.rowToConversation(row));
    const nextCursor = hasMore && conversations.length > 0
      ? encodeConversationCursor(conversations[conversations.length - 1].createdAt, conversations[conversations.length - 1].id)
      : undefined;

    return { conversations, cursor: nextCursor, hasMore };
  }

  async update(
    id: string,
    principalId: string,
    revision: number,
    updates: Partial<Pick<Conversation, 'title' | 'state' | 'preferredProjectId'>>,
  ): Promise<Conversation | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [existing] } = await client.query(
        `SELECT * FROM conversations WHERE id = $1 AND principal_id = $2 AND state NOT IN ('deleted','deleting') FOR UPDATE`,
        [id, principalId],
      );
      if (!existing || existing.revision !== revision) {
        await client.query('ROLLBACK');
        return undefined;
      }

      // Validate state transition
      if (updates.state) {
        const from = existing.state;
        const to = updates.state;
        if (from === 'active' && to !== 'archived') { await client.query('ROLLBACK'); return undefined; }
        if (from === 'archived' && to !== 'active') { await client.query('ROLLBACK'); return undefined; }
      }

      const now = Date.now();
      const newState = updates.state ?? existing.state;
      const newTitle = updates.title ?? existing.title;
      const newProjectId = updates.preferredProjectId !== undefined ? updates.preferredProjectId : existing.preferred_project_id;
      const newRevision = existing.revision + 1;
      const archivedAt = newState === 'archived' && existing.state !== 'archived' ? now : existing.archived_at;

      await client.query(`
        UPDATE conversations
        SET title = $1, state = $2, preferred_project_id = $3, revision = $4, updated_at = $5, archived_at = $6
        WHERE id = $7 AND principal_id = $8
      `, [newTitle, newState, newProjectId ?? null, newRevision, now, archivedAt ?? null, id, principalId]);

      if (newState === 'archived') {
        await client.query('DELETE FROM conversation_voice_claims WHERE conversation_id = $1', [id]);
      }

      const { rows: [updated] } = await client.query(
        'SELECT * FROM conversations WHERE id = $1 AND principal_id = $2',
        [id, principalId],
      );
      await client.query('COMMIT');
      return this.rowToConversation(updated);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(id: string, principalId: string, revision: number): Promise<DeleteResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [existing] } = await client.query(
        'SELECT * FROM conversations WHERE id = $1 AND principal_id = $2 FOR UPDATE',
        [id, principalId],
      );
      if (!existing || existing.state === 'deleted') {
        await client.query('ROLLBACK');
        return 'not_found';
      }
      if (existing.revision !== revision) {
        await client.query('ROLLBACK');
        return 'revision_conflict';
      }

      const now = Date.now();
      await client.query(`
        UPDATE conversations SET state = 'deleted', deleted_at = $1, revision = revision + 1, updated_at = $1
        WHERE id = $2 AND principal_id = $3
      `, [now, id, principalId]);

      await client.query('DELETE FROM conversation_voice_claims WHERE conversation_id = $1', [id]);
      await client.query('DELETE FROM conversation_messages WHERE conversation_id = $1', [id]);
      await client.query('DELETE FROM conversation_summaries WHERE conversation_id = $1', [id]);
      await client.query('DELETE FROM conversation_provider_sessions WHERE conversation_id = $1', [id]);
      await client.query('DELETE FROM conversation_task_links WHERE conversation_id = $1', [id]);

      await client.query('COMMIT');
      return 'deleted';
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getMessages(conversationId: string, principalId: string, options: { afterSeq?: number; limit?: number; cursor?: string }): Promise<MessagePage> {
    const { rows: convRows } = await this.pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND principal_id = $2 AND state != $3',
      [conversationId, principalId, 'deleted'],
    );
    if (convRows.length === 0) return { messages: [], hasMore: false };

    const limit = Math.min(options.limit ?? DEFAULT_MESSAGES_PAGE_SIZE, MAX_MESSAGES_PAGE_SIZE);
    let afterSeq = options.afterSeq ?? 0;
    const cursorSeq = options.cursor ? decodeSeqCursor(options.cursor) : undefined;
    if (cursorSeq !== undefined) afterSeq = Math.max(afterSeq, cursorSeq);

    const { rows } = await this.pool.query(
      'SELECT * FROM conversation_messages WHERE conversation_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3',
      [conversationId, afterSeq, limit + 1],
    );

    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map((row: any) => this.rowToMessage(row));
    const nextCursor = hasMore && messages.length > 0
      ? Buffer.from(String(messages[messages.length - 1].seq)).toString('base64url')
      : undefined;

    return { messages, cursor: nextCursor, hasMore };
  }

  async appendMessages(
    conversationId: string,
    principalId: string,
    epoch: number,
    messages: Omit<ConversationMessage, 'seq' | 'createdAt'>[],
  ): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [conv] } = await client.query(
        'SELECT * FROM conversations WHERE id = $1 AND principal_id = $2 AND state = $3 FOR UPDATE',
        [conversationId, principalId, 'active'],
      );
      if (!conv) {
        await client.query('ROLLBACK');
        throw new Error('CONVERSATION_NOT_ACTIVE');
      }

      // Require a current, unexpired claim with exact epoch
      const { rows: claimRows } = await client.query(
        'SELECT * FROM conversation_voice_claims WHERE conversation_id = $1',
        [conversationId],
      );
      if (claimRows.length === 0 || claimRows[0].principal_id !== principalId) {
        await client.query('ROLLBACK');
        throw new Error('NO_VOICE_CLAIM');
      }
      const claim = claimRows[0];
      if (Number(claim.epoch) !== epoch) {
        await client.query('ROLLBACK');
        throw new Error('STALE_EPOCH');
      }
      if (Number(claim.expires_at) < Date.now()) {
        await client.query('ROLLBACK');
        throw new Error('CLAIM_EXPIRED');
      }

      const now = Date.now();
      const result: ConversationMessage[] = [];
      let nextSeq = Number((await client.query(
        'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM conversation_messages WHERE conversation_id = $1',
        [conversationId],
      )).rows[0].max_seq) + 1;

      for (const msg of messages) {
        if (msg.clientEventId) {
          const { rows: existing } = await client.query(
            'SELECT * FROM conversation_messages WHERE conversation_id = $1 AND client_event_id = $2',
            [conversationId, msg.clientEventId],
          );
          if (existing.length > 0) {
            // Compare immutable fields for conflict detection
            if (existing[0].role !== msg.role || existing[0].kind !== msg.kind || existing[0].text !== msg.text) {
              await client.query('ROLLBACK');
              throw new Error('CLIENT_EVENT_CONFLICT');
            }
            result.push(this.rowToMessage(existing[0]));
            continue;
          }
        }

        await client.query(`
          INSERT INTO conversation_messages (
            id, conversation_id, seq, role, kind, text, client_event_id,
            provider_type, provider_model, provider_session_id, provider_epoch,
            provider_response_id, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `, [
          msg.id,
          conversationId,
          nextSeq,
          msg.role,
          msg.kind,
          msg.text,
          msg.clientEventId ?? null,
          msg.providerType ?? null,
          msg.providerModel ?? null,
          msg.providerSessionId ?? null,
          msg.providerEpoch ?? null,
          msg.providerResponseId ?? null,
          now,
        ]);

        result.push({ ...msg, conversationId, seq: nextSeq, createdAt: now } as ConversationMessage);
        nextSeq += 1;
      }

      const persistedThroughSeq = nextSeq - 1;
      await client.query(
        'UPDATE conversations SET revision = revision + 1, updated_at = $1 WHERE id = $2 AND principal_id = $3',
        [now, conversationId, principalId],
      );

      await client.query('COMMIT');
      return { messages: result, persistedThroughSeq: Math.max(0, persistedThroughSeq) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getHydration(conversationId: string, principalId: string): Promise<HydrationResult | undefined> {
    const { rows: convRows } = await this.pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND principal_id = $2 AND state != $3',
      [conversationId, principalId, 'deleted'],
    );
    if (convRows.length === 0) return undefined;

    const { rows: summaryRows } = await this.pool.query(
      'SELECT * FROM conversation_summaries WHERE conversation_id = $1 ORDER BY version DESC LIMIT 1',
      [conversationId],
    );
    const summary = summaryRows.length > 0 ? this.rowToSummary(summaryRows[0]) : undefined;
    const afterSeq = summary?.throughSeq ?? 0;

    // Bounded: at most MAX_HYDRATION_TURNS final user/assistant turns (fetch in reverse, then reverse back)
    const { rows: msgRows } = await this.pool.query(
      `SELECT * FROM conversation_messages WHERE conversation_id = $1 AND seq > $2
       AND role IN ('user', 'assistant') AND kind IN ('speech_final', 'typed')
       ORDER BY seq DESC LIMIT $3`,
      [conversationId, afterSeq, MAX_HYDRATION_TURNS],
    );

    msgRows.reverse();
    const messages: ConversationMessage[] = [];
    let totalBytes = 0;
    for (const row of msgRows) {
      const msg = this.rowToMessage(row);
      if (msg.text.length > MAX_HYDRATION_CHAR_PER_MSG) {
        msg.text = msg.text.slice(0, MAX_HYDRATION_CHAR_PER_MSG);
      }
      const encoded = Buffer.byteLength(JSON.stringify(msg), 'utf8');
      if (totalBytes + encoded > MAX_HYDRATION_TOTAL_BYTES) break;
      totalBytes += encoded;
      messages.push(msg);
    }

    return { summary, messages };
  }

  async upsertSummary(
    conversationId: string,
    principalId: string,
    epoch: number,
    summary: ConversationSummary,
  ): Promise<ConversationSummary> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [conv] } = await client.query(
        'SELECT * FROM conversations WHERE id = $1 AND principal_id = $2 AND state = $3 FOR UPDATE',
        [conversationId, principalId, 'active'],
      );
      if (!conv) { await client.query('ROLLBACK'); throw new Error('CONVERSATION_NOT_ACTIVE'); }

      const { rows: claimRows } = await client.query(
        'SELECT * FROM conversation_voice_claims WHERE conversation_id = $1 AND principal_id = $2 AND epoch = $3',
        [conversationId, principalId, epoch],
      );
      if (claimRows.length === 0) { await client.query('ROLLBACK'); throw new Error('NO_VOICE_CLAIM'); }
      if (Number(claimRows[0].expires_at) < Date.now()) { await client.query('ROLLBACK'); throw new Error('CLAIM_EXPIRED'); }

      const now = Date.now();
      await client.query(`
        INSERT INTO conversation_summaries (conversation_id, version, through_seq, text, model, policy, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(conversation_id, version)
        DO UPDATE SET through_seq = excluded.through_seq, text = excluded.text, model = excluded.model, policy = excluded.policy, updated_at = excluded.updated_at
      `, [
        summary.conversationId,
        summary.version,
        summary.throughSeq,
        summary.text,
        summary.model ?? null,
        summary.policy ?? null,
        summary.createdAt,
        now,
      ]);

      await client.query('COMMIT');
      return { ...summary, updatedAt: now };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getSummary(conversationId: string, principalId: string): Promise<ConversationSummary | undefined> {
    const { rows: convRows } = await this.pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND principal_id = $2 AND state != $3',
      [conversationId, principalId, 'deleted'],
    );
    if (convRows.length === 0) return undefined;

    const { rows } = await this.pool.query(
      'SELECT * FROM conversation_summaries WHERE conversation_id = $1 ORDER BY version DESC LIMIT 1',
      [conversationId],
    );
    return rows.length > 0 ? this.rowToSummary(rows[0]) : undefined;
  }

  async acquireVoiceClaim(conversationId: string, principalId: string, epoch: number, ttlMs: number): Promise<ConversationVoiceClaim | undefined> {
    const boundedTtl = Math.min(ttlMs, VOICE_CLAIM_MAX_TTL_MS);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [conv] } = await client.query(
        'SELECT * FROM conversations WHERE id = $1 AND principal_id = $2 AND state = $3 FOR UPDATE',
        [conversationId, principalId, 'active'],
      );
      if (!conv) {
        await client.query('ROLLBACK');
        return undefined;
      }

      const now = Date.now();

      // Check epoch fence
      const { rows: fenceRows } = await client.query(
        'SELECT max_epoch FROM conversation_epoch_fences WHERE conversation_id = $1 FOR UPDATE',
        [conversationId],
      );
      if (fenceRows.length > 0 && epoch <= fenceRows[0].max_epoch) {
        await client.query('ROLLBACK');
        return undefined;
      }

      const { rows: existingRows } = await client.query(
        'SELECT * FROM conversation_voice_claims WHERE conversation_id = $1 FOR UPDATE',
        [conversationId],
      );
      if (existingRows.length > 0) {
        const existing = existingRows[0];
        // Require strictly higher epoch for takeover (even if expired)
        if (epoch <= existing.epoch) {
          await client.query('ROLLBACK');
          return undefined;
        }
        await client.query('DELETE FROM conversation_voice_claims WHERE conversation_id = $1', [conversationId]);
      }

      const expiresAt = now + boundedTtl;
      await client.query(`
        INSERT INTO conversation_voice_claims (conversation_id, principal_id, epoch, claimed_at, expires_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [conversationId, principalId, epoch, now, expiresAt]);

      // Update epoch fence
      await client.query(`
        INSERT INTO conversation_epoch_fences (conversation_id, max_epoch)
        VALUES ($1, $2)
        ON CONFLICT(conversation_id)
        DO UPDATE SET max_epoch = excluded.max_epoch WHERE excluded.max_epoch > conversation_epoch_fences.max_epoch
      `, [conversationId, epoch]);

      await client.query('COMMIT');
      return { conversationId, principalId, epoch, claimedAt: now, expiresAt };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async releaseVoiceClaim(conversationId: string, principalId: string, epoch: number): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM conversation_voice_claims WHERE conversation_id = $1 AND principal_id = $2 AND epoch = $3',
      [conversationId, principalId, epoch],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getVoiceClaim(conversationId: string, principalId: string): Promise<ConversationVoiceClaim | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM conversation_voice_claims WHERE conversation_id = $1 AND principal_id = $2',
      [conversationId, principalId],
    );
    return rows.length > 0 ? this.rowToVoiceClaim(rows[0]) : undefined;
  }

  async beginProviderSession(
    conversationId: string,
    principalId: string,
    epoch: number,
    session: Omit<ConversationProviderSession, 'conversationId' | 'epoch'>,
  ): Promise<ConversationProviderSession> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [conv] } = await client.query(
        'SELECT * FROM conversations WHERE id = $1 AND principal_id = $2 AND state = $3 FOR UPDATE',
        [conversationId, principalId, 'active'],
      );
      if (!conv) { await client.query('ROLLBACK'); throw new Error('CONVERSATION_NOT_ACTIVE'); }

      const { rows: claimRows } = await client.query(
        'SELECT * FROM conversation_voice_claims WHERE conversation_id = $1 AND principal_id = $2 AND epoch = $3',
        [conversationId, principalId, epoch],
      );
      if (claimRows.length === 0) { await client.query('ROLLBACK'); throw new Error('NO_VOICE_CLAIM'); }
      if (Number(claimRows[0].expires_at) < Date.now()) { await client.query('ROLLBACK'); throw new Error('CLAIM_EXPIRED'); }

      await client.query(`
        INSERT INTO conversation_provider_sessions (
          conversation_id, epoch, provider, model, session_id, capabilities, started_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        conversationId,
        epoch,
        session.provider,
        session.model ?? null,
        session.sessionId ?? null,
        session.capabilities ?? null,
        session.startedAt,
        session.expiresAt ?? null,
      ]);

      await client.query('COMMIT');
      return { conversationId, epoch, ...session };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async finishProviderSession(
    conversationId: string,
    principalId: string,
    epoch: number,
    endedAt: number,
    endReason: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [conv] } = await client.query(
        'SELECT id FROM conversations WHERE id = $1 AND principal_id = $2 AND state != $3',
        [conversationId, principalId, 'deleted'],
      );
      if (!conv) { await client.query('ROLLBACK'); return false; }

      const result = await client.query(
        'UPDATE conversation_provider_sessions SET ended_at = $1, end_reason = $2 WHERE conversation_id = $3 AND epoch = $4 AND ended_at IS NULL',
        [endedAt, endReason, conversationId, epoch],
      );
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getProviderSessions(conversationId: string, principalId: string): Promise<ConversationProviderSession[]> {
    const { rows: convRows } = await this.pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND principal_id = $2 AND state != $3',
      [conversationId, principalId, 'deleted'],
    );
    if (convRows.length === 0) return [];

    const { rows } = await this.pool.query(
      'SELECT * FROM conversation_provider_sessions WHERE conversation_id = $1 ORDER BY epoch ASC',
      [conversationId],
    );
    return rows.map((row: any) => this.rowToProviderSession(row));
  }

  async linkTask(
    conversationId: string,
    principalId: string,
    link: ConversationTaskLink,
  ): Promise<{ link: ConversationTaskLink; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [conv] } = await client.query(
        'SELECT id FROM conversations WHERE id = $1 AND principal_id = $2 AND state != $3',
        [conversationId, principalId, 'deleted'],
      );
      if (!conv) { await client.query('ROLLBACK'); throw new Error('CONVERSATION_NOT_ACTIVE'); }

      const { rows } = await client.query(
        'SELECT * FROM conversation_task_links WHERE conversation_id = $1 AND task_id = $2',
        [link.conversationId, link.taskId],
      );
      if (rows.length > 0) {
        await client.query('COMMIT');
        return { link: this.rowToTaskLink(rows[0]), created: false };
      }

      await client.query(`
        INSERT INTO conversation_task_links (conversation_id, task_id, message_id, attempt_id, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [link.conversationId, link.taskId, link.messageId ?? null, link.attemptId ?? null, link.createdAt]);

      await client.query('COMMIT');
      return { link, created: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getLinkedTasks(conversationId: string, principalId: string): Promise<ConversationTaskLink[]> {
    const { rows: convRows } = await this.pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND principal_id = $2 AND state != $3',
      [conversationId, principalId, 'deleted'],
    );
    if (convRows.length === 0) return [];

    const { rows } = await this.pool.query(
      'SELECT * FROM conversation_task_links WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId],
    );
    return rows.map((row: any) => this.rowToTaskLink(row));
  }
}
