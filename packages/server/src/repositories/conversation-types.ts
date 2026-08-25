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

export interface ConversationRepository {
  create(conversation: Conversation, idempotencyKey?: string): Promise<{ conversation: Conversation; created: boolean }>;
  getById(id: string, principalId: string): Promise<Conversation | undefined>;
  list(principalId: string, options: {
    state?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationPage>;
  update(id: string, principalId: string, revision: number, updates: Partial<Pick<Conversation, 'title' | 'state' | 'preferredProjectId'>>): Promise<Conversation | undefined>;
  delete(id: string, principalId: string, revision: number): Promise<boolean>;

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

  upsertSummary(summary: ConversationSummary): Promise<ConversationSummary>;
  getSummary(conversationId: string, principalId: string): Promise<ConversationSummary | undefined>;

  acquireVoiceClaim(conversationId: string, principalId: string, epoch: number, ttlMs: number): Promise<ConversationVoiceClaim | undefined>;
  releaseVoiceClaim(conversationId: string, principalId: string, epoch: number): Promise<boolean>;
  getVoiceClaim(conversationId: string, principalId: string): Promise<ConversationVoiceClaim | undefined>;

  beginProviderSession(session: ConversationProviderSession): Promise<ConversationProviderSession>;
  finishProviderSession(conversationId: string, epoch: number, endedAt: number, endReason: string): Promise<boolean>;
  getProviderSessions(conversationId: string, principalId: string): Promise<ConversationProviderSession[]>;

  linkTask(link: ConversationTaskLink): Promise<{ link: ConversationTaskLink; created: boolean }>;
  getLinkedTasks(conversationId: string, principalId: string): Promise<ConversationTaskLink[]>;
}
