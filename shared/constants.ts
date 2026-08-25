import type { ColumnId, Priority, AgentStatus, AgentType, ConversationState, ConversationMessageRole, ConversationMessageKind } from './types.js';

export const VALID_PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'critical'] as const;
export const VALID_COLUMNS: readonly ColumnId[] = ['backlog', 'in-progress', 'review', 'done'] as const;
export const VALID_AGENT_STATUSES: readonly AgentStatus[] = ['idle', 'planning', 'executing', 'complete', 'failed'] as const;
export const VALID_AGENT_TYPES: readonly AgentType[] = ['copilot', 'claude', 'codex', 'opencode', 'hermes', 'openclaw', 'grok'] as const;

/** Allowed column transitions. Key = current column, value = columns you can move to. */
export const VALID_TRANSITIONS: Record<ColumnId, readonly ColumnId[]> = {
  'backlog': ['in-progress'],
  'in-progress': ['backlog', 'review'],
  'review': ['done', 'in-progress'],
  'done': ['in-progress'],
};

export function isValidPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (VALID_PRIORITIES as readonly string[]).includes(value);
}

export function isValidColumnId(value: unknown): value is ColumnId {
  return typeof value === 'string' && (VALID_COLUMNS as readonly string[]).includes(value);
}

export function isValidAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (VALID_AGENT_STATUSES as readonly string[]).includes(value);
}

export function isValidAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (VALID_AGENT_TYPES as readonly string[]).includes(value);
}

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MIN_AGENT_TIMEOUT_MINUTES = 1;
export const MAX_AGENT_TIMEOUT_MINUTES = 240;
export const MAX_GROUP_CHILDREN = 20;
export const MIN_GROUP_CHILDREN = 2;

export function isValidAgentTimeoutMinutes(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_AGENT_TIMEOUT_MINUTES
    && value <= MAX_AGENT_TIMEOUT_MINUTES;
}

export function isValidMaxConcurrency(value: unknown, childCount: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= childCount;
}

// ─── Conversation constants ─────────────────────────────────────────

export const VALID_CONVERSATION_STATES: readonly ConversationState[] = ['active', 'archived', 'deleting', 'deleted'] as const;
export const VALID_CONVERSATION_MESSAGE_ROLES: readonly ConversationMessageRole[] = ['user', 'assistant'] as const;
export const VALID_CONVERSATION_MESSAGE_KINDS: readonly ConversationMessageKind[] = ['speech_final', 'typed'] as const;

export const MAX_CONVERSATION_TITLE_LENGTH = 200;
export const MAX_CONVERSATION_MESSAGE_LENGTH = 2000;
export const MAX_CONVERSATION_SUMMARY_LENGTH = 8000;
export const MAX_MESSAGES_PER_APPEND = 50;
export const MAX_MESSAGES_PAGE_SIZE = 100;
export const DEFAULT_MESSAGES_PAGE_SIZE = 50;
export const VOICE_CLAIM_MIN_TTL_MS = 5_000; // 5 seconds
export const VOICE_CLAIM_MAX_TTL_MS = 300_000; // 5 minutes
export const VOICE_CLAIM_TTL_MS = 120_000; // 2 minutes default
export const MAX_CONVERSATIONS_PAGE_SIZE = 100;
export const DEFAULT_CONVERSATIONS_PAGE_SIZE = 25;
export const MAX_HYDRATION_TURNS = 24;
export const MAX_HYDRATION_CHAR_PER_MSG = 2000;
export const MAX_HYDRATION_TOTAL_BYTES = 16384; // 16 KiB
export const MAX_PROVIDER_LENGTH = 64;
export const MAX_MODEL_LENGTH = 128;
export const MAX_SESSION_ID_LENGTH = 256;
export const MAX_CAPABILITIES_LENGTH = 1024;
export const MAX_END_REASON_LENGTH = 128;
export const MAX_MESSAGE_ID_LENGTH = 128;
export const MAX_ATTEMPT_ID_LENGTH = 128;
export const MAX_SEARCH_QUERY_LENGTH = 200;

export function isValidConversationState(value: unknown): value is ConversationState {
  return typeof value === 'string' && (VALID_CONVERSATION_STATES as readonly string[]).includes(value);
}

export function isValidConversationMessageRole(value: unknown): value is ConversationMessageRole {
  return typeof value === 'string' && (VALID_CONVERSATION_MESSAGE_ROLES as readonly string[]).includes(value);
}

export function isValidConversationMessageKind(value: unknown): value is ConversationMessageKind {
  return typeof value === 'string' && (VALID_CONVERSATION_MESSAGE_KINDS as readonly string[]).includes(value);
}
