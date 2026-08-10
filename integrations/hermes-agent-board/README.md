# Hermes Agent Board Integration

This plugin gives every enabled Hermes profile a narrow tool surface for routing explicit coding-agent requests into the shared AI Agent Board.

## Environment

- `AGENT_BOARD_URL` — Board origin, normally `http://127.0.0.1:3001`
- `AGENT_BOARD_TOKEN_FILE` — preferred path to a mode-0600 scoped service token
- `AGENT_BOARD_TOKEN` — direct token fallback

## Install for one profile

```bash
mkdir -p "$HERMES_HOME/plugins"
ln -s /path/to/ai-agent-board/integrations/hermes-agent-board \
  "$HERMES_HOME/plugins/agent-board"
hermes plugins enable agent-board
hermes tools enable agent_board
```

Restart the profile gateway or start a new CLI session after enabling it. Install the same plugin into each profile that should route coding-agent work. Keep the Board token out of skill text and Git

## Tools

- `agent_board_list_projects`
- `agent_board_list_agents`
- `agent_board_route_task`
- `agent_board_get_task`
- `agent_board_send_message`

The plugin also bundles the `agent-board-routing` skill with trigger, execution-contract, and safety guidance

## Test

```bash
python -m unittest discover -s integrations/hermes-agent-board/tests -v
```
