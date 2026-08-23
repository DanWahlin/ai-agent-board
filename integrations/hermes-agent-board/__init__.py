"""Hermes integration for Dan's shared AI Agent Board."""

from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

_PLUGIN_DIR = os.path.dirname(__file__)
_SKILL_PATH = os.path.join(_PLUGIN_DIR, "skills", "agent-board-routing", "SKILL.md")


def _base_url() -> str:
    return os.getenv("AGENT_BOARD_URL", "").strip().rstrip("/")


def _token() -> str:
    token_file = os.getenv("AGENT_BOARD_TOKEN_FILE", "").strip()
    if token_file:
        try:
            with open(os.path.expanduser(token_file), "r", encoding="utf-8") as handle:
                return handle.read().strip()
        except OSError:
            return ""
    return os.getenv("AGENT_BOARD_TOKEN", "").strip()


def _available() -> bool:
    return bool(_base_url())


def _request(method: str, path: str, body: dict[str, Any] | None = None, idempotency_key: str | None = None) -> Any:
    url = f"{_base_url()}{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    token = _token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read()
            return json.loads(raw) if raw else {"success": True}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw)
        except json.JSONDecodeError:
            detail = {"error": raw or exc.reason}
        raise RuntimeError(f"Agent Board HTTP {exc.code}: {detail.get('error', detail)}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Agent Board unavailable: {exc.reason}") from exc


def _result(callable_):
    try:
        return json.dumps({"success": True, "data": callable_()}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)


def _list_projects(params: dict[str, Any], **_: Any) -> str:
    del params
    return _result(lambda: _request("GET", "/api/projects"))


def _list_agents(params: dict[str, Any], **_: Any) -> str:
    refresh = bool(params.get("refresh"))
    path = "/api/agents/refresh" if refresh else "/api/agents"
    method = "POST" if refresh else "GET"
    return _result(lambda: _request(method, path))


def _route_task(params: dict[str, Any], task_id: str = "", session_id: str = "", **kwargs: Any) -> str:
    raw_origin = params.get("origin")
    origin: dict[str, Any] = {str(k): v for k, v in raw_origin.items()} if isinstance(raw_origin, dict) else {}
    origin.setdefault("sourceProfile", os.getenv("HERMES_PROFILE", "default"))
    if session_id:
        origin.setdefault("sourceSession", session_id)
    if task_id:
        origin.setdefault("hermesTaskId", task_id)
    platform = kwargs.get("platform")
    if platform:
        origin.setdefault("sourcePlatform", platform)

    body: dict[str, Any] = {
        "project": params.get("project"),
        "autoStart": params.get("auto_start", True),
        "isolation": "worktree" if params.get("use_worktree", True) else "checkout",
        "provenance": origin,
    }
    optional_fields = {
        "agentType": params.get("agent"),
        "title": params.get("title"),
        "description": params.get("description"),
        "priority": params.get("priority"),
        "baseBranch": params.get("base_branch"),
        "branchName": params.get("branch_name"),
        "task": params.get("existing_task"),
        "relatedItem": params.get("related_item"),
    }
    body.update({key: value for key, value in optional_fields.items() if value is not None})
    timeout_minutes = params.get("timeout_minutes")
    if timeout_minutes is not None:
        body["timeoutMinutes"] = timeout_minutes
    stable = params.get("idempotency_key")
    if not stable:
        seed = json.dumps({"session": session_id, "origin": origin, "body": body}, sort_keys=True, default=str)
        stable = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return _result(lambda: _request("POST", "/api/orchestrations", body, str(stable)))


def _get_task(params: dict[str, Any], **_: Any) -> str:
    task_id = urllib.parse.quote(str(params.get("task_id", "")), safe="")
    return _result(lambda: _request("GET", f"/api/orchestrations/{task_id}"))


def _send_message(params: dict[str, Any], **_: Any) -> str:
    task_id = urllib.parse.quote(str(params.get("task_id", "")), safe="")
    body = {"message": params.get("message", "")}
    return _result(lambda: _request("POST", f"/api/orchestrations/{task_id}/message", body))


def _retry_task(params: dict[str, Any], **_: Any) -> str:
    task_id = urllib.parse.quote(str(params.get("task_id", "")), safe="")
    body: dict[str, Any] = {}
    if params.get("timeout_minutes") is not None:
        body["timeoutMinutes"] = params["timeout_minutes"]
    return _result(lambda: _request("POST", f"/api/orchestrations/{task_id}/retry", body))


_LIST_PROJECTS_SCHEMA = {
    "name": "agent_board_list_projects",
    "description": "List canonical AI Agent Board projects, aliases, repository mappings, and defaults. Use before routing when the project is not already an exact Board ID.",
    "parameters": {"type": "object", "properties": {}},
}

_LIST_AGENTS_SCHEMA = {
    "name": "agent_board_list_agents",
    "description": "List coding agents available to the shared AI Agent Board. Optionally refresh readiness first.",
    "parameters": {"type": "object", "properties": {"refresh": {"type": "boolean", "default": False}}},
}

_ROUTE_TASK_SCHEMA = {
    "name": "agent_board_route_task",
    "description": "Create related project work or continue an existing durable Board task. Exact IDs win; ambiguous names fail closed.",
    "parameters": {
        "type": "object",
        "properties": {
            "project": {"type": "string", "description": "Canonical project ID or unique project name/alias"},
            "existing_task": {"type": "string", "description": "Exact existing task ID or unique exact title to continue instead of creating a card"},
            "related_item": {"type": "string", "description": "Exact task ID or unique exact title to relate to this work"},
            "agent": {"type": "string", "enum": ["claude", "codex", "copilot", "grok", "opencode", "hermes", "openclaw"]},
            "title": {"type": "string"},
            "description": {"type": "string", "description": "Full execution contract with objective, requirements, acceptance criteria, verification, and safety boundaries"},
            "priority": {"type": "string", "enum": ["low", "medium", "high", "critical"], "default": "medium"},
            "auto_start": {"type": "boolean", "default": True},
            "use_worktree": {"type": "boolean", "default": True},
            "base_branch": {"type": "string"},
            "branch_name": {"type": "string"},
            "timeout_minutes": {"type": "integer", "minimum": 1, "maximum": 240, "description": "Optional task-specific execution limit. Omit for the Board default (60 minutes)."},
            "idempotency_key": {"type": "string", "description": "Stable caller-provided key; normally omitted so the plugin derives one from session and request"},
            "origin": {"type": "object", "description": "Optional non-secret origin metadata"},
        },
        "required": ["project"],
        "anyOf": [
            {"required": ["existing_task"]},
            {"required": ["agent", "title", "description"]},
        ],
    },
}

_GET_TASK_SCHEMA = {
    "name": "agent_board_get_task",
    "description": "Read one Agent Board task and its current project, agent, branch, status, summary, and direct link.",
    "parameters": {"type": "object", "properties": {"task_id": {"type": "string"}}, "required": ["task_id"]},
}

_SEND_MESSAGE_SCHEMA = {
    "name": "agent_board_send_message",
    "description": "Send a follow-up instruction to an actively running Agent Board task. Use instead of creating a duplicate card.",
    "parameters": {
        "type": "object",
        "properties": {"task_id": {"type": "string"}, "message": {"type": "string"}},
        "required": ["task_id", "message"],
    },
}

_RETRY_TASK_SCHEMA = {
    "name": "agent_board_retry_task",
    "description": "Retry an existing failed or timed-out Agent Board task on the same tracked card, optionally with a longer execution limit.",
    "parameters": {
        "type": "object",
        "properties": {
            "task_id": {"type": "string"},
            "timeout_minutes": {"type": "integer", "minimum": 1, "maximum": 240},
        },
        "required": ["task_id"],
    },
}


def register(ctx) -> None:
    ctx.register_tool(name="agent_board_list_projects", toolset="agent_board", schema=_LIST_PROJECTS_SCHEMA, handler=_list_projects, check_fn=_available, emoji="📋")
    ctx.register_tool(name="agent_board_list_agents", toolset="agent_board", schema=_LIST_AGENTS_SCHEMA, handler=_list_agents, check_fn=_available, emoji="🤖")
    ctx.register_tool(name="agent_board_route_task", toolset="agent_board", schema=_ROUTE_TASK_SCHEMA, handler=_route_task, check_fn=_available, emoji="🚀")
    ctx.register_tool(name="agent_board_get_task", toolset="agent_board", schema=_GET_TASK_SCHEMA, handler=_get_task, check_fn=_available, emoji="🔎")
    ctx.register_tool(name="agent_board_send_message", toolset="agent_board", schema=_SEND_MESSAGE_SCHEMA, handler=_send_message, check_fn=_available, emoji="💬")
    ctx.register_tool(name="agent_board_retry_task", toolset="agent_board", schema=_RETRY_TASK_SCHEMA, handler=_retry_task, check_fn=_available, emoji="🔁")
    ctx.register_skill("agent-board-routing", Path(_SKILL_PATH))
