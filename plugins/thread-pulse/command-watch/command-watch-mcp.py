#!/usr/bin/env python3
"""Command Watch MCP server: lets the Command Watch project page read your cards.

Claude Desktop starts this script (stdio). It reads calls.json from the
command-watch-server.py on 127.0.0.1:8765 (on this machine, or forwarded
from a container or VM) and hands the cards to the caller. Nothing leaves
the machine except through the Claude app that called the tool.
Standard library only.

    COMMAND_WATCH_URL=http://127.0.0.1:8765 python3 command-watch-mcp.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("COMMAND_WATCH_URL", "http://127.0.0.1:8765").rstrip("/")
VERSION = "0.1.0"
# The page polls every 1.5 s; never hang it on a dead port.
TIMEOUT_S = 3

TOOLS = [
    {
        "name": "list_calls",
        "description": "List the Claude Code shell commands on the Command Watch board, newest first. "
        "'ids' always holds every card in order; 'calls' holds only the cards updated at or after 'since' "
        "(epoch ms; omit for all).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "since": {"type": "number", "description": "Only return cards with updatedAt >= since (epoch ms)."},
                "limit": {"type": "integer", "description": "Maximum cards (default 50, max 100)."},
            },
        },
        "annotations": {"title": "List commands", "readOnlyHint": True, "openWorldHint": False},
    },
    {
        "name": "clear_finished",
        "description": "Remove every finished command from the Command Watch board. Running commands stay.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"title": "Remove finished commands", "readOnlyHint": False, "destructiveHint": True,
                        "idempotentHint": True, "openWorldHint": False},
    },
]


class Unreachable(Exception):
    pass


# Talk to the forwarded port directly, even when the desktop has a proxy set.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http(path: str, method: str = "GET"):
    req = urllib.request.Request(BASE + path, method=method, data=b"" if method == "POST" else None)
    try:
        with OPENER.open(req, timeout=TIMEOUT_S) as res:
            return json.loads(res.read())
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise Unreachable(f"Command Watch server not reachable at {BASE} ({e}). "
                          "Is command-watch-server.py running and port 8765 forwarded?") from e


def list_calls(args: dict) -> dict:
    limit = max(1, min(int(args.get("limit") or 50), 100))
    since = args.get("since")
    calls = http("/calls.json")[:limit]
    changed = [c for c in calls if since is None or (c.get("updatedAt") or 0) >= since]
    return {"ids": [c.get("id") for c in calls], "calls": changed, "source": BASE}


def clear_finished(_: dict) -> dict:
    return http("/clear", "POST")


HANDLERS = {"list_calls": list_calls, "clear_finished": clear_finished}


def result(payload: dict, error: bool = False) -> dict:
    out = {"content": [{"type": "text", "text": json.dumps(payload)}], "isError": error}
    if not error:
        out["structuredContent"] = payload
    return out


def handle(msg: dict):
    method = msg.get("method")
    params = msg.get("params") or {}
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "command-watch", "version": VERSION},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        fn = HANDLERS.get(params.get("name"))
        if not fn:
            return result({"error": f"unknown tool {params.get('name')}"}, error=True)
        try:
            return result(fn(params.get("arguments") or {}))
        except Unreachable as e:
            return result({"error": str(e)}, error=True)
    raise KeyError(method)


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if "id" not in msg:
            continue  # notifications (initialized, cancelled) need no answer
        try:
            reply = {"jsonrpc": "2.0", "id": msg["id"], "result": handle(msg)}
        except KeyError:
            reply = {"jsonrpc": "2.0", "id": msg["id"],
                     "error": {"code": -32601, "message": f"method not found: {msg.get('method')}"}}
        except Exception as e:  # keep the server alive for the next poll
            reply = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32603, "message": str(e)}}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
