---
name: agent-board-routing
description: "Use when Dan explicitly asks Claude, Codex, Copilot, Grok, Hermes, OpenCode, or OpenClaw to perform coding work. Route it through the shared AI Agent Board instead of launching the coding agent directly."
version: 1.0.0
---

# Agent Board Routing

## Trigger

Load this skill when Dan explicitly delegates project work to a named coding agent, for example:

- “Have Claude implement…”
- “Send this to Codex”
- “Use Copilot to fix…”
- “Have Grok work on…”
- “Put this on the Agent Board and run it”

Do not route general coding questions, comparisons, hypotheticals, quoted examples, or requests that explicitly say not to start work.

## Procedure

1. Call `agent_board_list_projects` when the project is not already identified by a canonical Board project ID
2. Resolve only an exact ID, exact repository path/URL, or unique project name/alias. Never silently use the Default project
3. Call `agent_board_list_agents` and confirm the explicitly requested agent is available. Never silently substitute another agent
4. Build a bounded execution contract containing:
   - objective
   - requirements and non-goals
   - acceptance criteria
   - relevant files or context
   - verification commands or expected checks
   - safety boundaries
5. Call `agent_board_route_task` with `auto_start=true` unless Dan said to queue it without starting
6. Return the project, agent, card ID, direct Board link, branch, and current status
7. Follow-ups for an active card should use `agent_board_send_message`, not create a duplicate card
8. Use `agent_board_get_task` to check status when Dan asks for progress
9. Use `timeout_minutes` for work expected to exceed the 60-minute Board default. If a task times out, call `agent_board_retry_task` on the existing card with a larger limit; never bypass tracking by launching the named coding agent directly

## Safety

An explicit delegation authorizes card creation, isolated branch/worktree creation, repository-local edits, and ordinary tests. It does not authorize pushing, opening or merging a PR, merging locally, publishing, deploying, changing external accounts, destructive migrations, secret changes, or irreversible cleanup

Unknown projects, unavailable agents, ambiguous routing, or dirty-checkout dependencies must block cleanly rather than guess. Agent completion moves work to Review, not Done

## Multiple tasks

For multiple tasks, create separate cards only when the lanes are genuinely independent. Keep dependent steps in one card. Parallel write-capable tasks must use separate worktrees
