#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://123.57.255.204:8089}"
DOC_DIR="${1:-${DOC_DIR:-}}"
ENV_FILE="${ENV_FILE:-}"
REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-/opt/documind/shared/.env}"
SSH_HOST="${SSH_HOST:-documind}"
PG_SSH_HOST="${PG_SSH_HOST:-$SSH_HOST}"
ES_SSH_HOST="${ES_SSH_HOST:-$SSH_HOST}"
ELASTICSEARCH_URL="${ELASTICSEARCH_URL:-http://127.0.0.1:8104}"
ES_INDEX="${ES_INDEX_CHUNKS:-chunks}"
POLL_SECONDS="${POLL_SECONDS:-180}"
PG_CONTAINER="${PG_CONTAINER:-documind-postgres}"
PG_USER="${PG_USER:-documind}"
PG_DATABASE="${PG_DATABASE:-documind_dev}"

if [[ -z "$DOC_DIR" || ! -d "$DOC_DIR" ]]; then
  echo "usage: DOC_DIR=/path/to/docs $0 or $0 /path/to/docs" >&2
  exit 2
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  ES_INDEX="${ES_INDEX_CHUNKS:-$ES_INDEX}"
fi

remote_env_value() {
  local key="$1"
  [[ -n "$SSH_HOST" ]] || return 1
  ssh "$SSH_HOST" "test -f '$REMOTE_ENV_FILE' && awk -F= '\$1 == \"$key\" { sub(/^[^=]*=/, \"\"); print }' '$REMOTE_ENV_FILE' | tail -n 1" 2>/dev/null || true
}

if [[ -z "${ES_INDEX_CHUNKS:-}" ]]; then
  remote_es_index="$(remote_env_value ES_INDEX_CHUNKS)"
  ES_INDEX="${remote_es_index:-$ES_INDEX}"
fi

LOGIN_EMAIL="${LOGIN_EMAIL:-${SUPER_ADMIN_EMAIL:-Anner}}"
LOGIN_PASSWORD="${LOGIN_PASSWORD:-${SUPER_ADMIN_PASSWORD:-1}}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 2
  }
}

need_cmd curl
need_cmd python3

json_value() {
  local expr="$1"
  python3 -c 'import json,sys; d=json.load(sys.stdin); v=eval(sys.argv[1], {"__builtins__": {}}, {"d": d, "len": len}); print("" if v is None else v)' "$expr"
}

json_payload() {
  python3 - "$@" <<'PY'
import json
import sys

kind = sys.argv[1]
if kind == "login":
    print(json.dumps({"email": sys.argv[2], "password": sys.argv[3]}, ensure_ascii=False))
elif kind == "term_doc":
    print(json.dumps({"query": {"term": {"doc_id": sys.argv[2]}}, "size": 1}, ensure_ascii=False))
elif kind == "match_doc":
    print(json.dumps({
        "query": {
            "bool": {
                "filter": [{"term": {"doc_id": sys.argv[2]}}],
                "must": [{"match": {"content": sys.argv[3]}}],
            }
        },
        "size": 1,
    }, ensure_ascii=False))
else:
    raise SystemExit(f"unknown payload kind: {kind}")
PY
}

login_payload="$(json_payload login "$LOGIN_EMAIL" "$LOGIN_PASSWORD")"

login_json="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$login_payload" \
  "$BASE_URL/api/v1/auth/login")"

token="$(json_value 'd.get("access_token", "")' <<<"$login_json")"
kb_id="${KB_ID:-$(json_value '(d.get("allowed_kb_ids") or [""])[0]' <<<"$login_json")}"

if [[ -z "$token" || -z "$kb_id" ]]; then
  echo "login succeeded but token or knowledge base id was missing" >&2
  exit 1
fi

files=()
while IFS= read -r file; do
  files+=("$file")
done < <(find "$DOC_DIR" -maxdepth 1 -type f \( \
  -iname '*.pdf' -o -iname '*.docx' -o -iname '*.pptx' \
\) | sort)

if [[ "${#files[@]}" -eq 0 ]]; then
  echo "no pdf/docx/pptx files found in $DOC_DIR" >&2
  exit 2
fi

doc_ids=()
for file in "${files[@]}"; do
  name="$(basename "$file")"
  echo "uploading: $name"
  upload_json="$(curl -fsS \
    -H "Authorization: Bearer $token" \
    -F "file=@${file}" \
    "$BASE_URL/api/knowledge-bases/$kb_id/documents")"
  doc_id="$(json_value 'd.get("document_id", "")' <<<"$upload_json")"
  parse_job_id="$(json_value 'd.get("parse_job_id", "")' <<<"$upload_json")"
  echo "uploaded: $name document_id=$doc_id parse_job_id=$parse_job_id"
  doc_ids+=("$doc_id")
done

for doc_id in "${doc_ids[@]}"; do
  deadline=$((SECONDS + POLL_SECONDS))
  last_status=""
  while (( SECONDS < deadline )); do
    detail="$(curl -fsS \
      -H "Authorization: Bearer $token" \
      "$BASE_URL/api/admin/documents/$doc_id")"
    status="$(json_value 'd.get("document", {}).get("parse_status", "")' <<<"$detail")"
    chunks="$(json_value 'd.get("document", {}).get("chunk_count", 0)' <<<"$detail")"
    if [[ "$status" != "$last_status" ]]; then
      echo "document $doc_id status=$status chunks=$chunks"
      last_status="$status"
    fi
    case "$status" in
      indexed)
        break
        ;;
      parse_failed|embedding_failed|parse_low_confidence)
        echo "document $doc_id failed or low confidence: $status" >&2
        python3 - "$detail" >&2 <<'PY'
import json
import sys

doc = json.loads(sys.argv[1])
document = doc.get("document", {})
latest_job = doc.get("latest_job", {})
metadata = document.get("metadata") or {}
summary = {
    "document_id": document.get("id"),
    "name": document.get("name"),
    "parse_status": document.get("parse_status"),
    "chunk_count": document.get("chunk_count"),
    "error_code": metadata.get("error_code") or latest_job.get("error_code"),
    "error_message": metadata.get("error_message") or latest_job.get("error_message"),
    "latest_job_status": latest_job.get("status"),
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
PY
        exit 1
        ;;
    esac
    sleep 3
  done
  if [[ "$last_status" != "indexed" ]]; then
    echo "document $doc_id did not become indexed within ${POLL_SECONDS}s" >&2
    exit 1
  fi
done

pg_query() {
  local sql="$1"
  local prefixed_sql="SET search_path TO documind, public; $sql"
  if [[ -n "$PG_SSH_HOST" ]]; then
    local remote_cmd
    local container_q user_q database_q
    printf -v container_q '%q' "$PG_CONTAINER"
    printf -v user_q '%q' "$PG_USER"
    printf -v database_q '%q' "$PG_DATABASE"
    remote_cmd="if command -v podman >/dev/null 2>&1; then podman exec -i $container_q psql -U $user_q -d $database_q -qAtX -v ON_ERROR_STOP=1; else docker exec -i $container_q psql -U $user_q -d $database_q -qAtX -v ON_ERROR_STOP=1; fi"
    printf '%s\n' "$prefixed_sql" | ssh "$PG_SSH_HOST" "$remote_cmd"
  elif [[ -n "${DATABASE_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
    printf '%s\n' "$prefixed_sql" | psql "$DATABASE_URL" -qAtX -v ON_ERROR_STOP=1
  elif command -v docker >/dev/null 2>&1 && docker container inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    printf '%s\n' "$prefixed_sql" | docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DATABASE" -qAtX -v ON_ERROR_STOP=1
  else
    return 127
  fi
}

pg_embedding_counts=()
if [[ "${SKIP_PG_VALIDATION:-0}" == "1" ]]; then
  echo "WARN: skipping PG validation because SKIP_PG_VALIDATION=1"
elif pg_query "SELECT 1" >/dev/null 2>&1; then
  for doc_id in "${doc_ids[@]}"; do
    counts="$(pg_query "
      SELECT
        (SELECT count(*) FROM document_blocks WHERE doc_id = '$doc_id'),
        (SELECT count(*) FROM cleaned_blocks WHERE doc_id = '$doc_id' AND is_removed = false),
        (SELECT count(*) FROM chunks WHERE doc_id = '$doc_id'),
        (SELECT count(*) FROM chunk_embeddings WHERE doc_id = '$doc_id' AND status = 'completed');
    ")"
    IFS='|' read -r block_count cleaned_count chunk_count embedding_count <<<"$counts"
    echo "pg: doc=$doc_id blocks=$block_count cleaned=$cleaned_count chunks=$chunk_count embeddings=$embedding_count"
    if [[ ! "$chunk_count" =~ ^[0-9]+$ || ! "$embedding_count" =~ ^[0-9]+$ || "$chunk_count" == "0" || "$embedding_count" == "0" || "$chunk_count" != "$embedding_count" ]]; then
      echo "pg validation failed for $doc_id" >&2
      exit 1
    fi
    pg_embedding_counts+=("$embedding_count")
  done
else
  echo "PG validation unavailable; set PG_SSH_HOST=documind or SKIP_PG_VALIDATION=1" >&2
  exit 1
fi

es_query() {
  local payload="$1"
  local url="${ELASTICSEARCH_URL%/}/$ES_INDEX/_search"
  if [[ -n "$ES_SSH_HOST" ]]; then
    local remote_cmd
    printf -v remote_cmd '%q ' curl -fsS -H 'Content-Type: application/json' -d @- "$url"
    printf '%s' "$payload" | ssh "$ES_SSH_HOST" "$remote_cmd"
  else
    curl -fsS -H 'Content-Type: application/json' -d "$payload" "$url"
  fi
}

if [[ "${SKIP_ES_VALIDATION:-0}" == "1" ]]; then
  echo "WARN: skipping ES validation because SKIP_ES_VALIDATION=1"
  echo "ingest API test passed: ${#doc_ids[@]} documents"
  exit 0
fi

for i in "${!doc_ids[@]}"; do
  doc_id="${doc_ids[$i]}"
  expected_embeddings="${pg_embedding_counts[$i]:-}"
  search_json="$(es_query "$(json_payload term_doc "$doc_id")")"
  hit_count="$(json_value 'd.get("hits", {}).get("total", {}).get("value", 0)' <<<"$search_json")"
  dim="$(json_value 'len(d.get("hits", {}).get("hits", [{}])[0].get("_source", {}).get("embedding", []))' <<<"$search_json")"
  content="$(json_value 'd.get("hits", {}).get("hits", [{}])[0].get("_source", {}).get("content", "")' <<<"$search_json")"
  echo "es: doc=$doc_id hits=$hit_count expected=$expected_embeddings embedding_dim=$dim"
  if [[ "$hit_count" == "0" || "$dim" == "0" ]]; then
    echo "es validation failed for $doc_id" >&2
    exit 1
  fi
  if [[ -n "$expected_embeddings" && "$hit_count" != "$expected_embeddings" ]]; then
    echo "es validation failed for $doc_id" >&2
    exit 1
  fi

  query_text="$(python3 - "$content" <<'PY'
import sys
text = sys.argv[1].replace("\n", " ").strip()
print(text[:40] if text else "document")
PY
)"
  match_json="$(es_query "$(json_payload match_doc "$doc_id" "$query_text")")"
  match_hits="$(json_value 'd.get("hits", {}).get("total", {}).get("value", 0)' <<<"$match_json")"
  echo "es-search: doc=$doc_id query_hits=$match_hits"
  if [[ "$match_hits" == "0" ]]; then
    echo "es content search failed for $doc_id" >&2
    exit 1
  fi
done

echo "ingest API test passed: ${#doc_ids[@]} documents"
