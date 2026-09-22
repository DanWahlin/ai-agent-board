# Session identity, state and recent-result contract (Phase 2.4)

Revision: 2026-09-22. This is an additive shared contract under Phase 2.1 and depends on the Phase 2.2 Role snapshot and Phase 2.3 Task lifecycle. It defines business Sessions only; it does not create an SDK Session, dispatch work, persist rows, stream events, or map provider states.

## Identity and associations

`Session.id` is an opaque business identity separate from `Task.id`. A Session ID must be nonblank, must not equal its Task ID, and must be unique in the storage scope. Every retry creates a new Session ID; reusing the old ID is invalid. `Session.taskId` is the immutable ownership link. Multiple Tasks may have Sessions with independent identities and state.

The Session starts in `Ready` and carries `createdAt`, `updatedAt`, nullable `startedAt`/`endedAt`, an optional Phase 2.2 `roleExecutionSnapshot`, an optional `executionAttemptId`, and an optional `sdkSessionId`. `executionAttemptId` points to the existing immutable orchestration request snapshot when present. `sdkSessionId` is null until a later Provider adapter creates or associates a real SDK session; the business Session remains the source of lifecycle identity.

`Task.session` is an additive `TaskSessionAssociation`:

| Field | Meaning | Missing value |
| --- | --- | --- |
| `taskId` | Ownership check for every association update | Required |
| `currentSessionId` | Latest admitted Session, including a terminal Session; this is null only before the first execution | `null` means never executed |
| `recentResult` | Latest terminal outcome for this Task | `null` means no terminal result exists |

Only one nonterminal Session can be current for a Task. A terminal current Session can be replaced by a new `Ready` Session after the Task follows the Phase 2.3 retry path (`Done`/`Active` → `Inbox` → `Active` as applicable). The previous terminal result remains the recent result until the new Session terminates.

## Five states and transitions

The exact serialized states are `Ready`, `Running`, `Waiting`, `Completed`, and `Failed`. `SESSION_STATE_TRANSITIONS` exports all 25 from/to combinations. Same-state requests are idempotent no-ops. Valid nonterminal transitions are:

| From | To | Action |
| --- | --- | --- |
| `Ready` | `Running` | `start` |
| `Running` | `Waiting` | `wait` |
| `Waiting` | `Running` | `resume` |
| `Running` | `Completed` | `complete` |
| `Waiting` | `Completed` | `complete` |
| `Running` | `Failed` | `fail` |
| `Waiting` | `Failed` | `fail` |

`Completed` and `Failed` are terminal and immutable in place. They cannot transition to another state or recover to `Ready`; a retry uses a new Session identity. `transitionSessionState` validates state-only transitions. `transitionSession(session, to, at)` applies a pure copy, preserves the first `startedAt`, records terminal `endedAt`, and rejects decreasing timestamps. It never mutates the input.

Errors include stable `invalid_state`, `invalid_transition`, or `terminal_state_immutable` codes plus original `from` and `to` values. Session object operations return structured field errors with stable codes and never partially apply an invalid update.

## Results and late-result isolation

`SessionRecentResult` contains `sessionId`, `outcome` (`success` or `failure`), `completedAt`, nullable `summary`, and nullable `error`. A `Completed` Session can produce only `success`; a `Failed` Session can produce only `failure`, and failures require a nonblank error. Success results cannot carry an error. `completedAt` cannot precede Session termination. A nonterminal Session has no result.

`createSessionResult` validates the terminal/result pairing. `recordSessionResult` writes a result only when its Session ID equals the Task association's current Session ID. A result from an older Session after retry returns `stale_session_result` and leaves the association unchanged. A duplicate result for the same Session returns `result_already_recorded`. Thus an old Session cannot overwrite a newer current state or recent result, even if its SDK event arrives late. Missing result remains explicit `recentResult: null`.

## Task lifecycle and Role boundaries

`createSession` accepts only a Phase 2.3 Task state of `Active`; `Draft`, `Inbox`, and `Done` cannot admit a Session. `Draft → Inbox` and `Inbox → Active` remain Task decisions and do not dispatch a Session. Session `Completed` or `Failed` does not automatically move the Task to `Done`; Phase 2.3 still requires explicit completion confirmation. Session failure is recorded in the recent result and the Task may later use its defined retry/reopen path.

When supplied, the Role execution snapshot is strictly validated, copied, and frozen on Session creation before it is associated with that Session. Role edits or later mutation of the caller's input cannot rewrite the stored selection. `ExecutionAttempt.sessionId` is optional for compatibility with existing attempts without business Session identity. `sdkSessionId` is independently nullable. No provider status mapping or runtime `sessions` map is changed here.

## Persistence and query contract for later phases

Phase 2.7 owns storage columns, foreign keys, uniqueness indexes, atomic association updates, and query implementation. It must preserve `currentSessionId` and `recentResult` as separate fields, enforce one current nonterminal Session per Task, and reject stale updates by Session identity/version. A read with no Session returns `currentSessionId: null` and `recentResult: null`; a read with a current nonterminal Session may still return the previous terminal `recentResult`.

No migration, route, WebSocket, SDK, or repository implementation is included in Phase 2.4. Existing `Task.columnId`, `Task.agentStatus`, `ExecutionAttempt.status`, and legacy event `taskId` fields remain valid for old consumers until a later explicit adapter defines the authoritative field and conflict behavior.
