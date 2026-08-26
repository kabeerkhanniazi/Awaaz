"""Thin AssemblyAI REST client. Standard library only, no pip install.

The only two things the browser needs from AssemblyAI are a short-lived token
and, optionally, the ids of stored agents. Everything else in this app is
configured inline over the WebSocket, so the API key never leaves this process.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"

# The API also answers on regional hosts; set AGENTS_API_BASE if the account
# is pinned to one (EU accounts use agents.eu.assemblyai.com).
DEFAULT_BASE = "https://agents.assemblyai.com/v1"


class ApiError(Exception):
    def __init__(self, label: str, status: int, body: str):
        super().__init__(f"{label} failed ({status}): {body}")
        self.status = status
        self.body = body


def load_env(path: Path = ENV_FILE) -> None:
    """KEY=value per line, # for comments, quotes optional. Anything already in
    the environment wins, so shell overrides and hosting platforms take
    precedence over the file."""
    try:
        text = path.read_text()
    except OSError:
        return
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r"\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$", line)
        if not match:
            continue
        key, raw = match.group(1), match.group(2)
        if key in os.environ:
            continue
        os.environ[key] = re.sub(r"^(['\"])(.*)\1$", r"\2", raw)


def api_base() -> str:
    return os.environ.get("AGENTS_API_BASE", DEFAULT_BASE).rstrip("/")


def api_key() -> str:
    return os.environ.get("ASSEMBLYAI_API_KEY", "")


def aai(path: str, method: str = "GET", body: Any = None) -> Any:
    """One call against the agents API. Raises ApiError on any non-2xx."""
    headers = {
        "Authorization": f"Bearer {api_key()}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        api_base() + path, data=data, method=method, headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            text = res.read().decode()
    except urllib.error.HTTPError as err:
        raise ApiError(f"{method} {path}", err.code, err.read().decode()) from None
    except urllib.error.URLError as err:
        raise ApiError(f"{method} {path}", 0, str(err.reason)) from None
    try:
        return json.loads(text) if text else {}
    except json.JSONDecodeError:
        return {}


def mint_token(expires_in_seconds: int = 600) -> dict:
    """A browser-safe credential. The page never sees ASSEMBLYAI_API_KEY.

    The starter mints 60-second tokens; we allow a little longer because a
    visitor may read the agent briefing before pressing Connect. The token
    only authorises opening a session, not reading the account.
    """
    expires = max(60, min(int(expires_in_seconds), 3600))
    return aai(f"/token?product=voice_agent&expires_in_seconds={expires}")


def is_key_problem(err: ApiError) -> bool:
    """The token endpoint answers an unusable key with 404 and a body of
    {"detail":"Invalid API key"}, not the 401 you would expect, so the status
    alone is not enough to tell a bad key from a bad URL."""
    return err.status in (401, 403) or "invalid api key" in (err.body or "").lower()


NO_KEY = ("ASSEMBLYAI_API_KEY is not set. Copy .env.example to .env and add your key "
          "from https://www.assemblyai.com/dashboard/api-keys")
BAD_KEY = ("ASSEMBLYAI_API_KEY was rejected. Check the key is correct, active, and has "
           "Voice Agent access at https://www.assemblyai.com/dashboard/api-keys")


def preflight() -> Optional[str]:
    """Returns an error string if the key is obviously unusable, else None."""
    if not api_key():
        return NO_KEY
    try:
        mint_token(60)
    except ApiError as err:
        if is_key_problem(err):
            return BAD_KEY
        return f"Could not reach the AssemblyAI agents API: {err}"
    return None


if __name__ == "__main__":
    load_env()
    problem = preflight()
    print(problem or f"OK - key accepted, agents API reachable at {api_base()}")
    sys.exit(1 if problem else 0)
