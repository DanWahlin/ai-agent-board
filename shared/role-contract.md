# Role and execution configuration contract (Phase 2.2)

Revision: 2026-09-22. Additive contract under the Phase 2.1 terminology and compatibility policy. Types are defined in `shared/types.ts`; functions are defined in `shared/constants.ts`, exposed through the existing `@ai-agent-board/shared/types.js` and `@ai-agent-board/shared/constants.js` package entry points. Client/server type re-exports continue to share those definitions.

## Fields and defaults

| Field | Type | Create | Update / meaning |
| --- | --- | --- | --- |
| `id` | string | Caller supplies a stable, nonblank opaque ID to `createRole`, separately from the input | Immutable; forbidden in create/update input. No leading/trailing whitespace. Allocation and uniqueness enforcement belong to storage. |
| `name` | string | Required, nonblank | Editable display name, trimmed. Neither identity nor Provider lookup key. Names need not be unique. |
| `responsibility` | string | Required, nonblank | Describes responsibility and boundaries; preserve original text. This is descriptive, not an enforced permission policy. |
| `instructions` | string | Required, nonblank | Role work instructions, preserving formatting; distinct from Task description and output. |
| `execution` | object | Required | Only `provider` and `model` are writable; a partial nested patch is allowed. |
| `execution.provider` | `ProviderType` | Required; no implicit fallback | Alias of existing `AgentType`: `copilot`, `claude`, `codex`, `opencode`, `hermes`, `openclaw`, `grok`. Exact lowercase identifiers. |
| `execution.model` | string or null | Optional; defaults to null | Nonblank trimmed model identifier scoped to the selected Provider; null explicitly selects that Provider's default. |

No model catalog is hardcoded. Validation proves shape and recognized Provider identity, not provider availability, model existence, authorization or executability. No text length limit is introduced by this minimal contract; transport/storage resource limits must be specified when these new commands are exposed. CLI commands, credentials and provider-specific options are not writable Role fields in this revision. CLI selection remains owned by provider integration; adding configurable CLI fields requires an explicit later contract extension.

## Creation, edits and errors

`validateCreateRole(unknown)` and `validateUpdateRole(unknown)` return `{ ok: true, value }` with a fresh normalized object, or `{ ok: false, errors }`. Each error has a stable `code`, dotted field `path` (empty for the root), and human-readable `message`. Codes: `required`, `invalid_type`, `blank`, `unknown_field`, `unknown_provider`. Consumers branch on code/path, not message wording. Validation returns no partial success. No HTTP status or route is introduced; a later API should translate validation failures to its documented client-error response.

Inputs must be plain objects. Both write commands reject unknown fields, including identity fields and unknown nested configuration fields. Missing, null and blank are distinct: create requires all fields except model; update preserves omitted fields; only model accepts null. Explicit JavaScript undefined is invalid when present (JSON callers should omit the field). Empty updates and empty execution patches are valid no-ops. There is no deletion operation here.

`createRole(id, input)` validates input and materializes a Role. `updateRole(existingRole, input)` takes an already valid Role, validates the entire patch, then returns a fresh Role without mutating the source. IDs remain unchanged. Unmentioned fields survive, including existing read-side extension data; callers must not echo read objects into write commands.

Changing only a model retains the Provider. Repeating the same Provider retains the model when omitted. Changing Provider resets an omitted model to null, so a selection cannot silently cross Provider boundaries. An explicitly supplied model or null wins when changing Provider. Invalid patches apply nothing.

## Execution selection and snapshots

The Role owns the Provider/model pair and instructions in this contract. An explicit model overrides the selected Provider's default; null delegates to that Provider's default. There is no generic cross-Provider model fallback. Existing Task/project/template defaults continue to work as before; this change neither merges those legacy configurations into Role nor defines competing runtime authority. Phase 4 must specify the explicit operation-level adaptation/override boundary before accepting Role and legacy task execution selections together.

`snapshotRoleExecution(validRole)` makes a detached, frozen selection snapshot containing roleId, name, responsibility, instructions and the Provider/model pair. Capture it when an execution is admitted; an existing execution must retain its captured selection after Role edits. Future executions may capture the edited Role. No Task, business Session, SDK Session or ExecutionAttempt is created by this helper.

The snapshot preserves null as the default-selection intent. It does **not** claim to capture the effective model resolved by provider configuration. Phase 4 must resolve and record that effective value, and any effective CLI/options, at admission before using this for reproducible execution. JSON round trips preserve the data but lose JavaScript freezing; persisted snapshot immutability must be enforced by the future storage boundary. No runtime code calls this helper yet.

## Storage, consumers and compatibility

Phase 2.7 owns Role storage, uniqueness, snapshot persistence, concurrency control and database mappings for both backends. No tables, migrations or optimistic-lock fields are introduced. Phase 2.4/2.6 may reference this Role identity and selection snapshot without treating it as a Session identity or a Handoff.

Existing Task, TaskTemplate, Project, ExecutionAttempt, AgentEvent, ColumnId, AgentStatus and legacy API validation remain unchanged. No implicit Role is fabricated from a template, provider label or old Task. All seven existing Providers remain accepted. New write validation is opt-in through these helpers; no legacy endpoint becomes stricter. Client/server builds and focused tests import the existing shared package boundary. Phase 2.8 can use the same helpers for consistency verification. No Phase 2.3+ state transitions, UI, dispatch, provider plugins or persistence wiring are implemented.
