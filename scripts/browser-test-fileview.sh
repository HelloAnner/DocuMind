#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://123.57.255.204:8089}"
LOGIN_EMAIL="${LOGIN_EMAIL:-Anner}"
LOGIN_PASSWORD="${LOGIN_PASSWORD:-1}"
PG_SSH_HOST="${PG_SSH_HOST:-documind}"
PG_CONTAINER="${PG_CONTAINER:-documind-postgres}"
PG_USER="${PG_USER:-documind}"
PG_DATABASE="${PG_DATABASE:-documind_dev}"
SCREENSHOT_PATH="${SCREENSHOT_PATH:-/tmp/documind-fileview-ocr.png}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 2
  }
}

need_cmd python3
need_cmd ssh
need_cmd agent-browser

open_documind() {
  local url="$1"
  local expected_prefix="${BASE_URL%/}"
  for attempt in 1 2 3; do
    agent-browser open "$url" >/dev/null 2>&1 || true
    agent-browser wait 2000 >/dev/null 2>&1 || true
    if agent-browser eval "location.href.startsWith('$expected_prefix')" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "failed to open DocuMind origin in browser: $url" >&2
  agent-browser get url || true
  return 1
}

prep_json="$(
  BASE_URL="$BASE_URL" \
  LOGIN_EMAIL="$LOGIN_EMAIL" \
  LOGIN_PASSWORD="$LOGIN_PASSWORD" \
  PG_SSH_HOST="$PG_SSH_HOST" \
  PG_CONTAINER="$PG_CONTAINER" \
  PG_USER="$PG_USER" \
  PG_DATABASE="$PG_DATABASE" \
  python3 - <<'PY'
import json
import os
import shlex
import subprocess
import urllib.request
import uuid

base_url = os.environ["BASE_URL"].rstrip("/")
login_email = os.environ["LOGIN_EMAIL"]
login_password = os.environ["LOGIN_PASSWORD"]
pg_ssh_host = os.environ["PG_SSH_HOST"]
pg_container = os.environ["PG_CONTAINER"]
pg_user = os.environ["PG_USER"]
pg_database = os.environ["PG_DATABASE"]


def http_json(method, path, payload=None, token=None, accept="application/json"):
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    headers = {"Accept": accept}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = resp.read().decode()
        return json.loads(body) if body else None


def sse_post(path, payload, token):
    req = urllib.request.Request(
        base_url + path,
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={
            "Accept": "text/event-stream",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    events = []
    current_event = None
    data_lines = []
    with urllib.request.urlopen(req, timeout=240) as resp:
        for raw in resp:
            line = raw.decode().rstrip("\n")
            if not line:
                if current_event:
                    data = json.loads("\n".join(data_lines)) if data_lines else {}
                    events.append({"event": current_event, "data": data})
                    if current_event in {"answer.completed", "answer.failed"}:
                        break
                current_event = None
                data_lines = []
                continue
            if line.startswith("event:"):
                current_event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].strip())
    return events


def run_pg(sql):
    remote = (
        f"podman exec -i {shlex.quote(pg_container)} "
        f"psql -U {shlex.quote(pg_user)} -d {shlex.quote(pg_database)} "
        "-qAtX -v ON_ERROR_STOP=1"
    )
    result = subprocess.run(
        ["ssh", pg_ssh_host, remote],
        input=f"SET search_path TO documind, public;\n{sql}",
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


row = run_pg(
    """
SELECT id, title
FROM documents
WHERE title LIKE 'ocr-smoke-%'
  AND parse_status = 'indexed'
  AND metadata->>'ocr_status' = 'completed'
ORDER BY updated_at DESC
LIMIT 1;
"""
)
if not row:
    raise SystemExit("no completed ocr-smoke document found; run scripts/api-test-preview-ocr.py first")
doc_id, title = row.split("|", 1)
marker = title.removeprefix("ocr-smoke-")

login = http_json("POST", "/api/v1/auth/login", {"email": login_email, "password": login_password})
token = login["access_token"]
kb_id = login["allowed_kb_ids"][0]
conv = http_json(
    "POST",
    "/api/conversations",
    {"title": f"Browser FileView smoke {marker}", "kb_ids": [kb_id]},
    token=token,
)
conv_id = conv["conversation_id"]
question = f"在 OCR smoke 文档 {marker} 中，验证码和城市分别是什么？"
events = sse_post(
    f"/api/conversations/{conv_id}/messages",
    {
        "content": question,
        "kb_ids": [],
        "client_request_id": f"browser-fileview-{uuid.uuid4()}",
        "stream": True,
    },
    token,
)
citations = [
    event["data"].get("citation")
    for event in events
    if event["event"] == "citation.delta" and event["data"].get("citation")
]
if not citations:
    raise SystemExit("prepared conversation did not return a citation")
anchor = citations[0].get("anchor") or {}
if anchor.get("location_status") != "exact" or not anchor.get("bbox"):
    raise SystemExit(json.dumps({"error": "citation is not exact bbox", "citation": citations[0]}, ensure_ascii=False))

auth = {
    "token": token,
    "userId": login["user"]["id"],
    "tenantId": login["tenant"]["id"],
    "email": login["user"]["email"],
    "roles": login["roles"],
}
print(json.dumps({"conv_id": conv_id, "marker": marker, "doc_id": doc_id, "auth": auth}, ensure_ascii=False))
PY
)"

conv_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["conv_id"])' "$prep_json")"
marker="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["marker"])' "$prep_json")"
auth_json="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["auth"], ensure_ascii=False))' "$prep_json")"

echo "prepared browser FileView conversation: conv_id=$conv_id marker=$marker"

open_documind "$BASE_URL/documind/"
agent-browser eval "localStorage.setItem('documind-auth', JSON.stringify($auth_json))"
open_documind "$BASE_URL/documind/chat?c=$conv_id"
agent-browser wait --text "$marker"
agent-browser eval 'document.querySelector(".dm-citation-card,.dm-citation-chip")?.click()'
agent-browser wait 5000

agent-browser eval '
const result = {
  url: location.href,
  hasExactStatus: document.body.innerText.includes("精确定位"),
  hasExactCopy: document.body.innerText.includes("已按原文锚点定位并高亮"),
  pdfCanvas: document.querySelectorAll("canvas").length,
  overlay: document.querySelectorAll(".dm-pdf-anchor-overlay").length,
  overlayChildren: Array.from(document.querySelectorAll(".dm-pdf-anchor-overlay")).map((node) => node.children.length),
  targetPages: document.querySelectorAll(".dm-pdf-single-page.is-target").length,
  readyPages: document.querySelectorAll(".dm-pdf-single-page.is-ready").length,
};
if (!result.hasExactStatus || !result.hasExactCopy || result.pdfCanvas < 1 || result.overlay < 1 || !result.overlayChildren.some((count) => count > 0) || result.targetPages < 1 || result.readyPages < 1) {
  throw new Error(JSON.stringify(result));
}
JSON.stringify(result);
'

agent-browser screenshot "$SCREENSHOT_PATH"
echo "browser FileView smoke passed: screenshot=$SCREENSHOT_PATH"
