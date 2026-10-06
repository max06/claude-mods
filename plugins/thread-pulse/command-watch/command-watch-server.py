#!/usr/bin/env python3
"""Command Watch: serves live cards for the shell commands Claude Code runs.

The thread-pulse mod writes one JSON file per Bash call to
~/.claude/command-watch/calls/. This server shows them on one page that
refreshes every 1.5 s. It listens on 127.0.0.1 only (forward the port to
reach it from outside a container or VM). Standard library only.

    command-watch-server.py [--port 8765] [--keep-hours 24]
"""

import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CALLS = Path.home() / ".claude" / "command-watch" / "calls"
PAGE = Path(__file__).with_name("command-watch.html")
SHOWN = 100


def load_calls(keep_s: float) -> list[dict]:
    now = time.time()
    calls = []
    for f in CALLS.glob("*.json"):
        try:
            age = now - f.stat().st_mtime
            if age > keep_s:
                f.unlink(missing_ok=True)
                continue
            calls.append(json.loads(f.read_text()))
        except (OSError, ValueError):
            continue  # being written right now; next poll gets it
    calls.sort(key=lambda c: c.get("startedAt", 0), reverse=True)
    return calls[:SHOWN]


def clear_finished() -> int:
    removed = 0
    for f in CALLS.glob("*.json"):
        try:
            if json.loads(f.read_text()).get("status") != "running":
                f.unlink(missing_ok=True)
                removed += 1
        except (OSError, ValueError):
            continue
    return removed


class Handler(BaseHTTPRequestHandler):
    keep_s = 24 * 3600

    def send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self.send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
        elif path == "/calls.json":
            body = json.dumps(load_calls(self.keep_s)).encode()
            self.send(200, body, "application/json")
        else:
            self.send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] == "/clear":
            self.send(200, json.dumps({"removed": clear_finished()}).encode(), "application/json")
        else:
            self.send(404, b"not found", "text/plain")

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=int(os.environ.get("COMMAND_WATCH_PORT", "8765")))
    ap.add_argument("--keep-hours", type=float, default=24)
    args = ap.parse_args()
    CALLS.mkdir(parents=True, exist_ok=True)
    Handler.keep_s = args.keep_hours * 3600
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Command Watch on http://127.0.0.1:{args.port}/ (reading {CALLS})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
