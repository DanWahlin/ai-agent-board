import Database from 'better-sqlite3';
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

export class SqliteConversationRepository implements ConversationRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private rowToConversation(row: any): Conversation {
    return {
      id: row.id,
      principalId: row.principal_id,
      title: row.title,
      state: row.state,
      preferredProjectId: row.preferred_project_id ?? undefined,
      revision: row.revision,
      requestHash: row.request_hash ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at ?? undefined,
      deletedAt: row.deleted_at ?? undefined,
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
      providerEpoch: row.provider_epoch ?? undefined,
      providerResponseId: row.provider_response_id ?? undefined,
      createdAt: row.created_at,
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      endReason: row.end_reason ?? undefined,
    };
  }

  private rowToTaskLink(row: any): ConversationTaskLink {
    return {
      conversationId: row.conversation_id,
      taskId: row.task_id,
      messageId: row.message_id ?? undefined,
      attemptId: row.attempt_id ?? undefined,
      createdAt: row.created_at,
    };
  }

  private rowToVoiceClaim(row: any): ConversationVoiceClaim {
    return {
      conversationId: row.conversation_id,
      principalId: row.principal_id,
      epoch: row.epoch,
      claimedAt: row.claimed_at,
      expiresAt: row.expires_at,
    };
  }

  async create(
    conversation: Conversation,
    idempotencyKey?: string,
    requestHash?: string,
  ): Promise<{ conversation: Conversation; created: boolean; conflict?: CreateConflict }> {
    return this.db.transaction(() => {
      if (idempotencyKey) {
        // Atomic: principal-scoped idempotency lookup
        const existing = this.db.prepare(
          'SELECT * FROM conversations WHERE idempotency_key = ? AND principal_id = ?'
        ).get(idempotencyKey, conversation.principalId) as any;
        if (existing) {
          if (requestHash && existing.request_hash && existing.request_hash !== requestHash) {
            return { conversation: this.rowToConversation(existing), created: false, conflict: 'IDEMPOTENCY_PAYLOAD_CONFLICT' as CreateConflict };
          }
          return { conversation: this.rowToConversation(existing), created: false };
        }
      }

      this.db.prepare(`
        INSERT INTO conversations (id, principal_id, title, state, preferred_project_id, revision, request_hash, created_at, updated_at, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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
      );

      return { conversation: { ...conversation, requestHash }, created: true };
    })();
  }

  async getById(id: string, principalId: string): Promise<Conversation | undefined> {
    const row = this.db.prepare(
      'SELECT * FROM conversations WHERE id = ? AND principal_id = ? AND state != ?'
    ).get(id, principalId, 'deleted') as any;
    return row ? this.rowToConversation(row) : undefined;
  }

  async list(principalId: string, options: { state?: string; cursor?: string; limit?: number }): Promise<ConversationPage> {
    const limit = Math.min(options.limit ?? DEFAULT_CONVERSATIONS_PAGE_SIZE, MAX_CONVERSATIONS_PAGE_SIZE);
    let query = 'SELECT * FROM conversations WHERE principal_id = ? AND state != ?';
    const params: any[] = [principalId, 'deleted'];

    if (options.state) {
      query += ' AND state = ?';
      params.push(options.state);
    }

    const cursor = options.cursor ? decodeConversationCursor(options.cursor) : undefined;
    if (cursor) {
      query += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(limit + 1);

    const rows = this.db.prepare(query).all(...params) as any[];
    const hasMore = rows.length > limit;
    const conversations = rows.slice(0, limit).map((row) => this.rowToConversation(row));
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
      WHERE c.principal_id = ? AND c.state != 'deleted'
        AND (c.title LIKE ? OR m.text LIKE ?)`;
    const params: any[] = [principalId, pattern, pattern];

    const cursor = options.cursor ? decodeConversationCursor(options.cursor) : undefined;
    if (cursor) {
      sql += ' AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))';
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    sql += ' ORDER BY c.created_at DESC, c.id DESC LIMIT ?';
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as any[];
    const hasMore = rows.length > limit;
    const conversations = rows.slice(0, limit).map((row) => this.rowToConversation(row));
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
    const now = Date.now();
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT * FROM conversations WHERE id = ? AND principal_id = ? AND state NOT IN (?, ?)'
      ).get(id, principalId, 'deleted', 'deleting') as any;
      if (!existing || existing.revision !== revision) return undefined;

      // Validate state transition
      if (updates.state) {
        const from = existing.state;
        const to = updates.state;
        if (from === 'active' && to !== 'archived') return undefined;
        if (from === 'archived' && to !== 'active') return undefined;
      }

      const newState = updates.state ?? existing.state;
      const newTitle = updates.title ?? existing.title;
      const newProjectId = updates.preferredProjectId !== undefined ? updates.preferredProjectId : existing.preferred_project_id;
      const newRevision = existing.revision + 1;
      const archivedAt = newState === 'archived' && existing.state !== 'archived' ? now : existing.archived_at;

      this.db.prepare(`
        UPDATE conversations
        SET title = ?, state = ?, preferred_project_id = ?, revision = ?, updated_at = ?, archived_at = ?
        WHERE id = ? AND principal_id = ?
      `).run(newTitle, newState, newProjectId ?? null, newRevision, now, archivedAt ?? null, id, principalId);

      if (newState === 'archived') {
        this.db.prepare('DELETE FROM conversation_voice_claims WHERE conversation_id = ?').run(id);
      }

      const row = this.db.prepare('SELECT * FROM conversations WHERE id = ? AND principal_id = ?').get(id, principalId) as any;
      return this.rowToConversation(row);
    })();
  }

  async delete(id: string, principalId: string, revision: number): Promise<DeleteResult> {
    const now = Date.now();
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT * FROM conversations WHERE id = ? AND principal_id = ?'
      ).get(id, principalId) as any;
      if (!existing || existing.state === 'deleted') return 'not_found';
      if (existing.revision !== revision) return 'revision_conflict';

      this.db.prepare(`
        UPDATE conversations
        SET state = 'deleted', deleted_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND principal_id = ?
      `).run(now, now, id, principalId);

      this.db.prepare('DELETE FROM conversation_voice_claims WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversation_provider_sessions WHERE conversation_id = ?').run(id);
      // Task links are deleted (conversation rows purged) but tasks table rows survive
      this.db.prepare('DELETE FROM conversation_task_links WHERE conversation_id = ?').run(id);

      return 'deleted';
    })();
  }

  async getMessages(conversationId: string, principalId: string, options: { afterSeq?: number; limit?: number; cursor?: string }): Promise<MessagePage> {
    const conv = this.db.prepare(
      'SELECT id FROM conversations WHERE id = ? AND principal_id = ? AND state != ?'
    ).get(conversationId, principalId, 'deleted') as any;
    if (!conv) return { messages: [], hasMore: false };

    const limit = Math.min(options.limit ?? DEFAULT_MESSAGES_PAGE_SIZE, MAX_MESSAGES_PAGE_SIZE);
    let afterSeq = options.afterSeq ?? 0;
    const cursorSeq = options.cursor ? decodeSeqCursor(options.cursor) : undefined;
    if (cursorSeq !== undefined) afterSeq = Math.max(afterSeq, cursorSeq);

    const rows = this.db.prepare(
      'SELECT * FROM conversation_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    ).all(conversationId, afterSeq, limit + 1) as any[];

    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map((row) => this.rowToMessage(row));
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
    return this.db.transaction(() => {
      const conv = this.db.prepare(
        'SELECT * FROM conversations WHERE id = ? AND principal_id = ? AND state = ?'
      ).get(conversationId, principalId, 'active') as any;
      if (!conv) throw new Error('CONVERSATION_NOT_ACTIVE');

      // Require a current, unexpired claim with exact epoch
      const claim = this.db.prepare(
        'SELECT * FROM conversation_voice_claims WHERE conversation_id = ?'
      ).get(conversationId) as any;
      if (!claim || claim.principal_id !== principalId) throw new Error('NO_VOICE_CLAIM');
      if (claim.epoch !== epoch) throw new Error('STALE_EPOCH');
      if (claim.expires_at < Date.now()) throw new Error('CLAIM_EXPIRED');

      const now = Date.now();
      const result: ConversationMessage[] = [];
      let nextSeq = ((this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM conversation_messages WHERE conversation_id = ?'
      ).get(conversationId) as { max_seq: number }).max_seq) + 1;

      for (const msg of messages) {
        if (msg.clientEventId) {
          const existing = this.db.prepare(
            'SELECT * FROM conversation_messages WHERE conversation_id = ? AND client_event_id = ?'
          ).get(conversationId, msg.clientEventId) as any;
          if (existing) {
            // Compare immutable fields for conflict detection
            if (existing.role !== msg.role || existing.kind !== msg.kind || existing.text !== msg.text) {
              throw new Error('CLIENT_EVENT_CONFLICT');
            }
            result.push(this.rowToMessage(existing));
            continue;
          }
        }

        this.db.prepare(`
          INSERT INTO conversation_messages (
            id, conversation_id, seq, role, kind, text, client_event_id,
            provider_type, provider_model, provider_session_id, provider_epoch,
            provider_response_id, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
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
        );

        result.push({ ...msg, conversationId, seq: nextSeq, createdAt: now } as ConversationMessage);
        nextSeq += 1;
      }

      const persistedThroughSeq = (nextSeq - 1) || ((this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM conversation_messages WHERE conversation_id = ?'
      ).get(conversationId) as { max_seq: number }).max_seq);

      this.db.prepare(
        'UPDATE conversations SET revision = revision + 1, updated_at = ? WHERE id = ? AND principal_id = ?'
      ).run(now, conversationId, principalId);

      return { messages: result, persistedThroughSeq };
    })();
  }

  async getHydration(conversationId: string, principalId: string): Promise<HydrationResult | undefined> {
    const conv = this.db.prepare(
      'SELECT * FROM conversations WHERE id = ? AND principal_id = ? AND state != ?'
    ).get(conversationId, principalId, 'deleted') as any;
    if (!conv) return undefined;

    const summaryRow = this.db.prepare(
      'SELECT * FROM conversation_summaries WHERE conversation_id = ? ORDER BY version DESC LIMIT 1'
    ).get(conversationId) as any;
    const summary = summaryRow ? this.rowToSummary(summaryRow) : undefined;
    const afterSeq = summary?.throughSeq ?? 0;

    // Bounded: at most MAX_HYDRATION_TURNS final user/assistant turns
    const rows = this.db.prepare(`
      SELECT * FROM conversation_messages
      WHERE conversation_id = ? AND seq > ?
        AND role IN ('user', 'assistant') AND kind IN ('speech_final', 'typed')
      ORDER BY seq DESC
      LIMIT ?
    `).all(conversationId, afterSeq, MAX_HYDRATION_TURNS) as any[];

    // Reverse to chronological order and apply per-message and total size bounds
    rows.reverse();
    const messages: ConversationMessage[] = [];
    let totalBytes = 0;
    for (const row of rows) {
      const msg = this.rowToMessage(row);
      // Truncate per-message text
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
    return this.db.transaction(() => {
      // Validate principal ownership and active claim
      const conv = this.db.prepare(
        'SELECT * FROM conversations WHERE id = ? AND principal_id = ? AND state = ?'
      ).get(conversationId, principalId, 'active') as any;
      if (!conv) throw new Error('CONVERSATION_NOT_ACTIVE');

      const claim = this.db.prepare(
        'SELECT * FROM conversation_voice_claims WHERE conversation_id = ? AND principal_id = ? AND epoch = ?'
      ).get(conversationId, principalId, epoch) as any;
      if (!claim) throw new Error('NO_VOICE_CLAIM');
      if (claim.expires_at < Date.now()) throw new Error('CLAIM_EXPIRED');

      const now = Date.now();
      this.db.prepare(`
        INSERT INTO conversation_summaries (conversation_id, version, through_seq, text, model, policy, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, version)
        DO UPDATE SET through_seq = excluded.through_seq, text = excluded.text, model = excluded.model, policy = excluded.policy, updated_at = excluded.updated_at
      `).run(
        summary.conversationId,
        summary.version,
        summary.throughSeq,
        summary.text,
        summary.model ?? null,
        summary.policy ?? null,
        summary.createdAt,
        now,
      );
      return { ...summary, updatedAt: now };
    })();
  }

  async getSummary(conversationId: string, principalId: string): Promise<ConversationSummary | undefined> {
    const conv = this.db.prepare(
      'SELECT id FROM conversations WHERE id = ? AND principal_id = ? AND state != ?'
    ).get(conversationId, principalId, 'deleted') as any;
    if (!conv) return undefined;

    const row = this.db.prepare(
      'SELECT * FROM conversation_summaries WHERE conversation_id = ? ORDER BY version DESC LIMIT 1'
    ).get(conversationId) as any;
    return row ? this.rowToSummary(row) : undefined;
  }

  async acquireVoiceClaim(conversationId: string, principalId: string, epoch: number, ttlMs: number): Promise<ConversationVoiceClaim | undefined> {
    // Bound TTL by server policy
    const boundedTtl = Math.min(ttlMs, VOICE_CLAIM_MAX_TTL_MS);
    const now = Date.now();
    return this.db.transaction(() => {
      const conv = this.db.prepare(
        'SELECT * FROM conversations WHERE id = ? AND principal_id = ? AND state = ?'
      ).get(conversationId, principalId, 'active') as any;
      if (!conv) return undefined;

      // Check epoch fence: epoch must be strictly greater than max recorded
      const fence = this.db.prepare(
        'SELECT max_epoch FROM conversation_epoch_fences WHERE conversation_id = ?'
      ).get(conversationId) as { max_epoch: number } | undefined;
      if (fence && epoch <= fence.max_epoch) return undefined;

      const existing = this.db.prepare(
        'SELECT * FROM conversation_voice_claims WHERE conversation_id = ?'
      ).get(conversationId) as any;
      if (existing) {
        // Require strictly higher epoch for takeover (even if expired)
        if (epoch <= existing.epoch) return undefined;
        this.db.prepare('DELETE FROM conversation_voice_claims WHERE conversation_id = ?').run(conversationId);
      }

      const expiresAt = now + boundedTtl;
      this.db.prepare(`
        INSERT INTO conversation_voice_claims (conversation_id, principal_id, epoch, claimed_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(conversationId, principalId, epoch, now, expiresAt);

      // Update epoch fence
      this.db.prepare(`
        INSERT INTO conversation_epoch_fences (conversation_id, max_epoch)
        VALUES (?, ?)
        ON CONFLICT(conversation_id)
        DO UPDATE SET max_epoch = excluded.max_epoch WHERE excluded.max_epoch > conversation_epoch_fences.max_epoch
      `).run(conversationId, epoch);

      return { conversationId, principalId, epoch, claimedAt: now, expiresAt };
    })();
  }

  async releaseVoiceClaim(conversationId: string, principalId: string, epoch: number): Promise<boolean> {
    const result = this.db.prepare(
      'DELETE FROM conversation_voice_claims WHERE conversation_id = ? AND principal_id = ? AND epoch = ?'
    ).run(conversationId, principalId, epoch);
    return result.changes > 0;
  }

  async getVoiceClaim(conversationId: string, principalId: string): Promise<ConversationVoiceClaim | undefined> {
    const row = this.db.prepare(
      'SELECT * FROM conversation_voice_claims WHERE conversation_id = ? AND principal_id = ?'
    ).get(conversationId, principalId) as any;
    return row ? this.rowToVoiceClaim(row) : undefined;
  }

  async beginProviderSession(
    conversationId: string,
    principalId: string,
    epoch: number,
    session: Omit<ConversationProviderSession, 'conversationId' | 'epoch'>,
  ): Promise<ConversationProviderSession> {
    return this.db.transaction(() => {
      const conv = this.db.prepare(
        'SELECT * FROM conversations WHERE id = ? AND principal_id = ? AND state = ?'
      ).get(conversationId, principalId, 'active') as any;
      if (!conv) throw new Error('CONVERSATION_NOT_ACTIVE');

      // Validate active claim with matching epoch
      const claim = this.db.prepare(
        'SELECT * FROM conversation_voice_claims WHERE conversation_id = ? AND principal_id = ? AND epoch = ?'
      ).get(conversationId, principalId, epoch) as any;
      if (!claim) throw new Error('NO_VOICE_CLAIM');
      if (claim.expires_at < Date.now()) throw new Error('CLAIM_EXPIRED');

      this.db.prepare(`
        INSERT INTO conversation_provider_sessions (
          conversation_id, epoch, provider, model, session_id, capabilities, started_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversationId,
        epoch,
        session.provider,
        session.model ?? null,
        session.sessionId ?? null,
        session.capabilities ?? null,
        session.startedAt,
        session.expiresAt ?? null,
      );
      return { conversationId, epoch, ...session };
    })();
  }

  async finishProviderSession(
    conversationId: string,
    principalId: string,
    epoch: number,
    endedAt: number,
    endReason: string,
  ): Promise<boolean> {
    return this.db.transaction(() => {
      const conv = this.db.prepare(
        'SELECT id FROM conversations WHERE id = ? AND principal_id = ? AND state != ?'
      ).get(conversationId, principalId, 'deleted') as any;
      if (!conv) return false;

      const result = this.db.prepare(
        'UPDATE conversation_provider_sessions SET ended_at = ?, end_reason = ? WHERE conversation_id = ? AND epoch = ? AND ended_at IS NULL'
      ).run(endedAt, endReason, conversationId, epoch);
      return result.changes > 0;
    })();
  }

  async getProviderSessions(conversationId: string, principalId: string): Promise<ConversationProviderSession[]> {
    const conv = this.db.prepare(
      'SELECT id FROM conversations WHERE id = ? AND principal_id = ? AND state != ?'
    ).get(conversationId, principalId, 'deleted') as any;
    if (!conv) return [];

    const rows = this.db.prepare(
      'SELECT * FROM conversation_provider_sessions WHERE conversation_id = ? ORDER BY epoch ASC'
    ).all(conversationId) as any[];
    return rows.map((row) => this.rowToProviderSession(row));
  }

  async linkTask(
    conversationId: string,
    principalId: string,
    link: ConversationTaskLink,
  ): Promise<{ link: ConversationTaskLink; created: boolean }> {
    return this.db.transaction(() => {
      const conv = this.db.prepare(
        'SELECT id FROM conversations WHERE id = ? AND principal_id = ? AND state != ?'
      ).get(conversationId, principalId, 'deleted') as any;
      if (!conv) throw new Error('CONVERSATION_NOT_ACTIVE');

      const existing = this.db.prepare(
        'SELECT * FROM conversation_task_links WHERE conversation_id = ? AND task_id = ?'
      ).get(link.conversationId, link.taskId) as any;
      if (existing) return { link: this.rowToTaskLink(existing), created: false };

      this.db.prepare(`
        INSERT INTO conversation_task_links (conversation_id, task_id, message_id, attempt_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(link.conversationId, link.taskId, link.messageId ?? null, link.attemptId ?? null, link.createdAt);

      return { link, created: true };
    })();
  }

  async getLinkedTasks(conversationId: string, principalId: string): Promise<ConversationTaskLink[]> {
    const conv = this.db.prepare(
      'SELECT id FROM conversations WHERE id = ? AND principal_id = ? AND state != ?'
    ).get(conversationId, principalId, 'deleted') as any;
    if (!conv) return [];

    const rows = this.db.prepare(
      'SELECT * FROM conversation_task_links WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as any[];
    return rows.map((row) => this.rowToTaskLink(row));
  }
}
