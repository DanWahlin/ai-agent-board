// Re-export all types and validation utilities from the shared module
export type {
  Priority,
  ColumnId,
  AgentStatus,
  AgentType,
  Task,
  TaskProvenance,
  TaskGroup,
  TaskTemplate,
  TaskAttachment,
  Project,
  ProjectTaskCounts,
  ProjectConfig,
  CreateProjectRequest,
  UpdateProjectRequest,
  AgentEvent,
  WSMessage,
} from '../../../shared/types.js';

export {
  VALID_TRANSITIONS,
  isValidPriority,
  isValidColumnId,
  isValidAgentStatus,
  isValidAgentType,
  MAX_GROUP_CHILDREN,
  MIN_GROUP_CHILDREN,
} from '../../../shared/constants.js';
