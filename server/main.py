#!/usr/bin/env python3
"""Awaaz - the web server.

    python server/main.py

Standard library only. No pip install, no virtualenv, no build step.

The browser talks straight to AssemblyAI over the WebSocket, so this process is
deliberately small. It does four things:

    GET  /api/catalog              the five agents, for rendering
    GET  /api/session/<agent>      a 10-minute token plus the inline config
    POST /api/tools/<agent>        run one client-side tool call
    GET  /*                        the static site

The API key stays in this process. The page only ever receives a token that
authorises opening a voice session and nothing else.
"""

import json
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WEB = ROOT / "web"
sys.path.insert(0, str(HERE))

import agent_defs  # noqa: E402
import mockdb  # noqa: E402
from aai import (BAD_KEY, NO_KEY, ApiError, is_key_problem, load_env,  # noqa: E402
                 mint_token, preflight)
from aai import api_key as aai_key  # noqa: E402

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")

MAX_BODY = 256 * 1024


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Awaaz"

    # --- plumbing ---------------------------------------------------------

    def _send(self, status, body: bytes, content_type: str, cache: str = "no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        # The page is same-origin and mints no cross-site requests; these are
        # just the cheap headers that cost nothing to set correctly.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, payload):
        self._send(status, json.dumps(payload).encode(), "application/json")

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(length).decode())
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def log_message(self, *args):
        pass  # quiet; real problems are printed where they happen

    # --- routes -----------------------------------------------------------

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/catalog":
            return self._json(200, agent_defs.catalog())

        if path == "/api/health":
            return self._json(200, {"ok": True, "agents": len(agent_defs.AGENTS)})

        if path.startswith("/api/session/"):
            agent_id = path[len("/api/session/"):].strip("/")
            if agent_id not in agent_defs.BY_ID:
                return self._json(404, {"error": f"no agent '{agent_id}'"})
            voice = (parse_qs(parsed.query).get("voice") or [""])[0]
            try:
                token = mint_token(600)
            except ApiError as err:
                print(f"[token] {err}", flush=True)
                if not aai_key():
                    hint = NO_KEY
                elif is_key_problem(err):
                    hint = BAD_KEY
                else:
                    hint = "The AssemblyAI agents API did not answer. Check your connection."
                return self._json(502, {"error": "could not start a session", "hint": hint})
            return self._json(200, {
                "token": token.get("token"),
                "ws_url": "wss://agents.assemblyai.com/v1/ws",
                "session": agent_defs.session_config(agent_id, voice),
            })

        return self._static(path)

    def do_HEAD(self):  # noqa: N802
        self.do_GET()

    def do_POST(self):  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if not path.startswith("/api/tools/"):
            return self._json(404, {"error": "not found"})

        agent_id = path[len("/api/tools/"):].strip("/")
        payload = self._read_json()
        if payload is None:
            return self._json(400, {"error": "expected a JSON body"})

        tool = payload.get("name") or ""
        args = payload.get("arguments") or {}
        if not isinstance(args, dict):
            args = {}

        result = mockdb.dispatch(agent_id, tool, args)
        print(f"[tool] {agent_id}.{tool}({json.dumps(args)[:160]}) -> "
              f"{json.dumps(result)[:200]}", flush=True)
        return self._json(200, {"result": result})

    # --- static -----------------------------------------------------------

    def _static(self, path: str):
        # Three real pages, one shell. Any unknown path renders the app and the
        # client router decides, so deep links and refreshes work.
        if path in ("/", "/agents", "/call") or path.startswith("/call/"):
            return self._page()

        candidate = (WEB / path.lstrip("/")).resolve()
        try:
            candidate.relative_to(WEB.resolve())
        except ValueError:
            return self._json(403, {"error": "forbidden"})

        if candidate.is_file():
            ctype = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype == "application/javascript":
                ctype += "; charset=utf-8"
            return self._send(200, candidate.read_bytes(), ctype, cache="no-cache")

        return self._page()

    def _page(self):
        html = (WEB / "index.html").read_bytes()
        self._send(200, html, "text/html; charset=utf-8", cache="no-cache")


def main():
    load_env()

    problem = preflight()
    if problem:
        print("\n  ! " + problem + "\n", flush=True)
        print("  The site will still load and you can read every agent, but")
        print("  pressing Connect will fail until the key is set.\n")
    else:
        print("\n  AssemblyAI key accepted.\n")

    fixed = os.environ.get("PORT")
    port = int(fixed) if fixed else 3000
    while True:
        try:
            httpd = ThreadingHTTPServer(("", port), Handler)
            break
        except OSError:
            if fixed or port >= 3020:
                raise
            port += 1

    print(f"  Awaaz running at  http://localhost:{port}", flush=True)
    print(f"  {len(agent_defs.AGENTS)} agents  ·  Ctrl-C to stop\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped\n")
        httpd.server_close()


if __name__ == "__main__":
    main()
