import type {
  Conversation,
  ConversationMessage,
  ConversationSummary,
  ConversationProviderSession,
  ConversationTaskLink,
  ConversationVoiceClaim,
} from '../types.js';

export interface ConversationPage {
  conversations: Conversation[];
  cursor?: string;
  hasMore: boolean;
}

export interface MessagePage {
  messages: ConversationMessage[];
  cursor?: string;
  hasMore: boolean;
}

export interface AppendResult {
  messages: ConversationMessage[];
  persistedThroughSeq: number;
}

export interface HydrationResult {
  summary?: ConversationSummary;
  messages: ConversationMessage[];
}

export interface SearchResult {
  conversations: Conversation[];
  cursor?: string;
  hasMore: boolean;
}

export type CreateConflict = 'IDEMPOTENCY_PAYLOAD_CONFLICT';
export type AppendError = 'CONVERSATION_NOT_ACTIVE' | 'NO_VOICE_CLAIM' | 'STALE_EPOCH' | 'CLAIM_EXPIRED' | 'CLIENT_EVENT_CONFLICT';
export type DeleteResult = 'deleted' | 'not_found' | 'revision_conflict';

export interface ConversationRepository {
  create(
    conversation: Conversation,
    idempotencyKey?: string,
    requestHash?: string,
  ): Promise<{ conversation: Conversation; created: boolean; conflict?: CreateConflict }>;

  getById(id: string, principalId: string): Promise<Conversation | undefined>;

  list(principalId: string, options: {
    state?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationPage>;

  search(principalId: string, query: string, options: {
    cursor?: string;
    limit?: number;
  }): Promise<SearchResult>;

  update(
    id: string,
    principalId: string,
    revision: number,
    updates: Partial<Pick<Conversation, 'title' | 'state' | 'preferredProjectId'>>,
  ): Promise<Conversation | undefined>;

  delete(id: string, principalId: string, revision: number): Promise<DeleteResult>;

  getMessages(conversationId: string, principalId: string, options: {
    afterSeq?: number;
    limit?: number;
    cursor?: string;
  }): Promise<MessagePage>;

  appendMessages(
    conversationId: string,
    principalId: string,
    epoch: number,
    messages: Omit<ConversationMessage, 'seq' | 'createdAt'>[],
  ): Promise<AppendResult>;

  getHydration(conversationId: string, principalId: string): Promise<HydrationResult | undefined>;

  upsertSummary(
    conversationId: string,
    principalId: string,
    epoch: number,
    summary: ConversationSummary,
  ): Promise<ConversationSummary>;

  getSummary(conversationId: string, principalId: string): Promise<ConversationSummary | undefined>;

  acquireVoiceClaim(
    conversationId: string,
    principalId: string,
    epoch: number,
    ttlMs: number,
  ): Promise<ConversationVoiceClaim | undefined>;

  releaseVoiceClaim(conversationId: string, principalId: string, epoch: number): Promise<boolean>;

  getVoiceClaim(conversationId: string, principalId: string): Promise<ConversationVoiceClaim | undefined>;

  beginProviderSession(
    conversationId: string,
    principalId: string,
    epoch: number,
    session: Omit<ConversationProviderSession, 'conversationId' | 'epoch'>,
  ): Promise<ConversationProviderSession>;

  finishProviderSession(
    conversationId: string,
    principalId: string,
    epoch: number,
    endedAt: number,
    endReason: string,
  ): Promise<boolean>;

  getProviderSessions(conversationId: string, principalId: string): Promise<ConversationProviderSession[]>;

  linkTask(
    conversationId: string,
    principalId: string,
    link: ConversationTaskLink,
  ): Promise<{ link: ConversationTaskLink; created: boolean }>;

  getLinkedTasks(conversationId: string, principalId: string): Promise<ConversationTaskLink[]>;
}
