#!/usr/bin/env python3
"""Install the Agent Board Hermes plugin into one or more Hermes homes."""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def update_env(path: Path, values: dict[str, str]) -> None:
    existing = path.read_text().splitlines() if path.exists() else []
    keys = set(values)
    kept = [line for line in existing if not any(line.startswith(f"{key}=") for key in keys)]
    kept.extend(f"{key}={value}" for key, value in values.items())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(kept) + "\n")
    path.chmod(0o600)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin-source", required=True)
    parser.add_argument("--board-url", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("homes", nargs="+")
    args = parser.parse_args()

    source = Path(args.plugin_source).resolve()
    if not (source / "plugin.yaml").is_file():
        raise SystemExit(f"plugin.yaml not found under {source}")
    token = Path(args.token_file).resolve()
    if not token.is_file():
        raise SystemExit(f"token file not found: {token}")
    token.chmod(0o600)

    for raw_home in args.homes:
        home = Path(os.path.expanduser(raw_home)).resolve()
        plugins = home / "plugins"
        plugins.mkdir(parents=True, exist_ok=True)
        target = plugins / "agent-board"
        if target.is_symlink() or target.exists():
            if target.is_symlink() and target.resolve() == source:
                pass
            else:
                raise SystemExit(f"refusing to replace existing plugin path: {target}")
        else:
            target.symlink_to(source, target_is_directory=True)
        update_env(home / ".env", {
            "AGENT_BOARD_URL": args.board_url.rstrip("/"),
            "AGENT_BOARD_TOKEN_FILE": str(token),
        })
        print(f"installed {target} and configured {home / '.env'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
