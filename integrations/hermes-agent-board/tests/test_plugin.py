from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).resolve().parents[1] / "__init__.py"
SPEC = importlib.util.spec_from_file_location("agent_board_plugin", PLUGIN_PATH)
assert SPEC and SPEC.loader
plugin = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(plugin)


class Handler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str, dict[str, str], dict]] = []

    def do_GET(self):
        self._reply()

    def do_POST(self):
        self._reply()

    def log_message(self, format: str, *args):
        del format, args
        return

    def _reply(self):
        size = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(size)) if size else {}
        self.requests.append((self.command, self.path, dict(self.headers), body))
        payload: object = {
            "task": {"id": "task-1", "projectId": "demo", "agentType": "claude"},
            "contract": {
                "taskId": "task-1",
                "projectId": "demo",
                "deepLink": "https://board/projects/demo/tasks/task-1",
            },
        }
        if self.path == "/api/projects":
            payload = [{"id": "demo", "name": "Demo"}]
        elif self.path.startswith("/api/agents"):
            payload = [{"name": "claude", "available": True}]
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())


class PluginTests(unittest.TestCase):
    def setUp(self):
        Handler.requests.clear()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_route_task_and_idempotency(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("secret-token")
            env = {
                "AGENT_BOARD_URL": f"http://127.0.0.1:{self.server.server_port}",
                "AGENT_BOARD_TOKEN_FILE": str(token_file),
            }
            with patch.dict(os.environ, env, clear=False):
                raw = plugin._route_task(
                    {
                        "project": "demo",
                        "agent": "claude",
                        "title": "Do work",
                        "description": "Objective and acceptance criteria",
                        "related_item": "task-0",
                    },
                    session_id="session-1",
                )
        result = json.loads(raw)
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["contract"]["taskId"], "task-1")
        method, path, headers, body = Handler.requests[-1]
        self.assertEqual((method, path), ("POST", "/api/orchestrations"))
        self.assertEqual(headers["Authorization"], "Bearer secret-token")
        self.assertEqual(len(headers["Idempotency-Key"]), 64)
        self.assertEqual(body["provenance"]["sourceSession"], "session-1")
        self.assertEqual(body["isolation"], "worktree")
        self.assertEqual(body["agentType"], "claude")
        self.assertEqual(body["relatedItem"], "task-0")
        self.assertNotIn("timeoutMinutes", body)

        with patch.dict(os.environ, env, clear=False):
            plugin._route_task(
                {
                    "project": "demo",
                    "agent": "claude",
                    "title": "Deep review",
                    "description": "Review thoroughly",
                    "timeout_minutes": 120,
                },
                session_id="session-2",
            )
        self.assertEqual(Handler.requests[-1][3]["timeoutMinutes"], 120)

        with patch.dict(os.environ, env, clear=False):
            plugin._route_task(
                {"project": "demo", "existing_task": "task-1", "description": "Continue"},
                session_id="session-3",
            )
        continuation = Handler.requests[-1][3]
        self.assertEqual(continuation["task"], "task-1")
        self.assertEqual(continuation["description"], "Continue")
        self.assertNotIn("title", continuation)
        self.assertNotIn("agentType", continuation)

    def test_registers_tools_and_skill(self):
        class Context:
            def __init__(self):
                self.tools = []
                self.skills = []

            def register_tool(self, **kwargs):
                self.tools.append(kwargs)

            def register_skill(self, name, path):
                self.skills.append((name, path))

        ctx = Context()
        with patch.dict(os.environ, {"AGENT_BOARD_URL": "http://127.0.0.1:1"}, clear=False):
            plugin.register(ctx)
        self.assertEqual(
            {item["name"] for item in ctx.tools},
            {
                "agent_board_list_projects",
                "agent_board_list_agents",
                "agent_board_route_task",
                "agent_board_get_task",
                "agent_board_send_message",
                "agent_board_retry_task",
            },
        )
        self.assertEqual(ctx.skills[0][0], "agent-board-routing")
        self.assertTrue(Path(ctx.skills[0][1]).is_file())


if __name__ == "__main__":
    unittest.main()
