# Task lifecycle and transition contract (Phase 2.3)

Revision: 2026-09-22. This is an additive domain contract under Phase 2.1. The shared source of truth is `shared/types.ts` and `shared/constants.ts`, exposed through the existing shared package entry points. It does not replace the legacy Board `ColumnId` or `AgentStatus` fields.

## States and meaning

The serialized state values are exact title-case strings:

| State | Meaning | Entry semantics |
| --- | --- | --- |
| `Draft` | A Task exists as a draft and has not been submitted by a Human | Creation starts here in the new lifecycle model. No execution qualification exists. |
| `Inbox` | A submitted Task is waiting for execution qualification or an explicit human decision | `Draft → Inbox` means Human submission. It does not start an Agent or create a Session. |
| `Active` | The Task has received execution qualification and is eligible for work | `Inbox → Active` is an admission decision. It does not itself dispatch an Agent. |
| `Done` | The Task has an explicit completion confirmation | Completion is not inferred from `AgentStatus`, a Role snapshot, an SDK Session, or a Board column. |

`Task` remains the domain entity; `Card` remains a Board display term. Execution state and Task lifecycle state are separate. This contract deliberately has no `Failed` Task state: a failed or retryable Active attempt returns to `Inbox`, while execution/session failure details belong to later contracts. A completed Task can be reopened to `Inbox` for new qualification.

## Complete transition matrix

The matrix is exported as `TASK_LIFECYCLE_TRANSITIONS`; every one of the 16 from/to combinations is explicit. Same-state requests are successful idempotent no-ops.

| From \ To | `Draft` | `Inbox` | `Active` | `Done` |
| --- | --- | --- | --- | --- |
| `Draft` | noop | submit | reject | reject |
| `Inbox` | withdraw | noop | qualify | reject |
| `Active` | reject | retry | noop | complete* |
| `Done` | reject | reopen | reject | noop |

`Draft → Inbox` is Human submission; `Inbox → Active` grants execution qualification. Neither transition dispatches execution. `Active → Inbox` represents retry after failure or a deliberate return for more work; it does not erase execution history. `Done → Inbox` is reopening. `Active → Done` is the only completion path and requires `completionConfirmed: true` in the pure helper call. The helper has no Session requirement, so an explicit Human/system completion can complete a Task with no Session; later flows may require their own evidence before passing that confirmation.

The action labels are stable: `noop`, `submit`, `withdraw`, `qualify`, `retry`, `complete`, and `reopen`. The matrix is validation metadata, not a dispatch instruction.

## Entry points and errors

`isValidTaskLifecycleState(value)` validates the new state set without accepting old lowercase Board values. `getTaskLifecycleTransition(from, to)` returns the matrix entry or a structured failure. `transitionTaskLifecycle(from, to, context)` performs the same validation and additionally enforces completion confirmation.

Successful results are `{ ok: true, state, transition }`. Failures are `{ ok: false, error }` and always include the original `from` and `to` values. Stable error codes are:

| Code | Meaning |
| --- | --- |
| `invalid_state` | Either endpoint is absent or is not one of the four exact state values. No case folding or legacy-column coercion occurs. |
| `invalid_transition` | Both endpoints are valid but their matrix entry is forbidden. |
| `completion_confirmation_required` | `Active → Done` was requested without explicit `completionConfirmed: true`. |

The pure helpers return a new result and never mutate a Task. Callers should reject the command and preserve the stored state on any failure. Error messages are explanatory only; consumers should branch on `code` and `from`/`to`, not message text.

## Role/execution and compatibility boundary

`transitionTaskLifecycle` accepts only explicit completion confirmation; it does not accept a Role snapshot, Agent status, Session result, Board column, or any other execution signal as lifecycle evidence. Role selection and execution provenance remain attached to their Session, so a Role edit cannot rewrite lifecycle history or silently move a Task. The effective Provider/model and Session rules remain later-phase responsibilities.

The existing lowercase `ColumnId` values (`backlog`, `in-progress`, `review`, `done`), `AgentStatus` values and API behavior remain unchanged. No automatic two-way mapping is introduced: `backlog` cannot be guessed as `Draft` or `Inbox`, and `review` cannot be treated as `Done`. A later adapter must name its authoritative side, preserve unmappable legacy values, and define conflict handling before any consumer migration. This task adds no routes, persistence fields, UI, drag/drop behavior, Agent startup, or Session contract.

## Downstream use

Phase 2.4 may associate Session identity and execution outcomes with a Task without changing these state meanings. Phase 2.6 may reference the Task lifecycle state from Handoff records. Storage and migration concerns remain outside this task. Later runtime flows must pass explicit completion evidence and must not infer `Done` from a provider event alone.
