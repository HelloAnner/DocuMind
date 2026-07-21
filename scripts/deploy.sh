#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-documind}"
DEPLOY_PORT="${DEPLOY_PORT:-8089}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/documind}"
DEPLOY_TARGET="${DEPLOY_TARGET:-x86_64-unknown-linux-musl}"
LOCAL_BINARY="${LOCAL_BINARY:-target/deploy-linux-x86_64-musl/$DEPLOY_TARGET/release/documind}"
RELEASE_ID="${RELEASE_ID:-$(date +%Y%m%d-%H%M%S)}"
REMOTE_PG_CONTAINER="${REMOTE_PG_CONTAINER:-documind-postgres}"
REMOTE_REDIS_CONTAINER="${REMOTE_REDIS_CONTAINER:-documind-redis}"
REMOTE_RABBITMQ_CONTAINER="${REMOTE_RABBITMQ_CONTAINER:-documind-rabbitmq}"
REMOTE_ES_CONTAINER="${REMOTE_ES_CONTAINER:-documind-elasticsearch}"
REMOTE_MINIO_CONTAINER="${REMOTE_MINIO_CONTAINER:-documind-minio}"
REMOTE_PG_USER="${REMOTE_PG_USER:-documind}"
REMOTE_PG_DATABASE="${REMOTE_PG_DATABASE:-documind_dev}"
REMOTE_DATABASE_URL="${REMOTE_DATABASE_URL:-postgres://documind:documind@127.0.0.1:8100/documind_dev?options=-csearch_path%3Ddocumind%2Cpublic}"
REMOTE_REDIS_URL="${REMOTE_REDIS_URL:-redis://127.0.0.1:8101/0}"
REMOTE_RABBITMQ_URL="${REMOTE_RABBITMQ_URL:-amqp://guest:guest@127.0.0.1:8102/%2f}"
REMOTE_ELASTICSEARCH_URL="${REMOTE_ELASTICSEARCH_URL:-http://127.0.0.1:8104}"
REMOTE_MINIO_ENDPOINT="${REMOTE_MINIO_ENDPOINT:-http://127.0.0.1:9010}"
REMOTE_POSTGRES_IMAGE="${REMOTE_POSTGRES_IMAGE:-m.daocloud.io/docker.io/library/postgres:16-alpine}"
REMOTE_REDIS_IMAGE="${REMOTE_REDIS_IMAGE:-m.daocloud.io/docker.io/library/redis:7-alpine}"
REMOTE_RABBITMQ_IMAGE="${REMOTE_RABBITMQ_IMAGE:-m.daocloud.io/docker.io/library/rabbitmq:3-management-alpine}"
REMOTE_ES_IMAGE="${REMOTE_ES_IMAGE:-m.daocloud.io/docker.elastic.co/elasticsearch/elasticsearch:8.14.3}"
REMOTE_MINIO_IMAGE="${REMOTE_MINIO_IMAGE:-m.daocloud.io/docker.io/minio/minio:RELEASE.2024-07-16T23-46-41Z}"

if [[ "$DEPLOY_HOST" != "documind" && "${ALLOW_CUSTOM_DEPLOY_HOST:-0}" != "1" ]]; then
  echo "Refusing non-default deploy host: $DEPLOY_HOST"
  echo "Set ALLOW_CUSTOM_DEPLOY_HOST=1 if you really want to override ssh documind."
  exit 1
fi

if [[ ! -x "$LOCAL_BINARY" ]]; then
  echo "Missing deploy binary: $LOCAL_BINARY"
  echo "Run: make deploy-build"
  exit 1
fi

binary_info="$(file "$LOCAL_BINARY")"
if ! echo "$binary_info" | grep -qi 'ELF.*x86-64'; then
  echo "Deploy binary must be a Linux x86_64 ELF executable:"
  echo "$binary_info"
  exit 1
fi
if echo "$binary_info" | grep -qi 'interpreter '; then
  echo "Deploy binary must be fully static and must not require a dynamic loader:"
  echo "$binary_info"
  exit 1
fi

local_sha256="$(shasum -a 256 "$LOCAL_BINARY" | awk '{print $1}')"

REMOTE_RELEASE="$REMOTE_ROOT/releases/$RELEASE_ID"
REMOTE_CURRENT="$REMOTE_ROOT/current"
REMOTE_SHARED="$REMOTE_ROOT/shared"
REMOTE_ENV="$REMOTE_SHARED/.env"
REMOTE_LOG="$REMOTE_SHARED/logs/documind-$DEPLOY_PORT.log"
REMOTE_PID="$REMOTE_SHARED/runtime/documind-$DEPLOY_PORT.pid"
TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"' EXIT

remote_env_content="$(ssh "$DEPLOY_HOST" "test -f '$REMOTE_ENV' && cat '$REMOTE_ENV' || true" 2>/dev/null || true)"
existing_jwt_secret="$(printf '%s\n' "$remote_env_content" | grep -E '^JWT_SECRET=' | tail -1 | cut -d= -f2- || true)"
jwt_secret="${existing_jwt_secret:-$(openssl rand -hex 32 2>/dev/null || date +%s | shasum -a 256 | awk '{print $1}')}"

remote_env_value() {
  printf '%s\n' "$remote_env_content" | grep -E "^$1=" | tail -1 | cut -d= -f2- || true
}

llm_api_key="$(remote_env_value LLM_API_KEY)"
if [[ -z "$llm_api_key" ]]; then
  llm_api_key="$(remote_env_value LLM_API)"
fi
llm_base_url="$(remote_env_value LLM_BASE_URL)"
llm_base_url="${llm_base_url:-http://localhost:11434/v1}"
llm_model="$(remote_env_value LLM_MODEL)"
llm_model="${llm_model:-qwen2.5:14b}"
use_real_llm="$(remote_env_value USE_REAL_LLM)"
use_real_llm="${use_real_llm:-false}"
embed_model="$(remote_env_value EMBED_MODEL)"
embed_model="${embed_model:-text-embedding-v3}"
embed_base_url="$(remote_env_value EMBED_BASE_URL)"
embed_base_url="${embed_base_url:-$llm_base_url}"
embed_api_key="$(remote_env_value EMBED_API_KEY)"
embed_api_key="${embed_api_key:-$llm_api_key}"
embed_batch_size="$(remote_env_value EMBED_BATCH_SIZE)"
embed_batch_size="${embed_batch_size:-10}"
embed_dim="$(remote_env_value EMBED_DIM)"
embed_dim="${embed_dim:-1024}"
embed_retry_max="$(remote_env_value EMBED_RETRY_MAX)"
embed_retry_max="${embed_retry_max:-3}"
embed_worker_poll_ms="$(remote_env_value EMBED_WORKER_POLL_MS)"
embed_worker_poll_ms="${embed_worker_poll_ms:-1000}"
embed_enabled="$(remote_env_value EMBED_ENABLED)"
embed_enabled="${embed_enabled:-true}"
es_index_chunks="$(remote_env_value ES_INDEX_CHUNKS)"
es_index_chunks="${es_index_chunks:-chunks}"
es_index_alias="$(remote_env_value ES_INDEX_ALIAS)"
es_index_alias="${es_index_alias:-chunks_search}"
es_index_schema_version="$(remote_env_value ES_INDEX_SCHEMA_VERSION)"
es_index_schema_version="${es_index_schema_version:-2}"
rerank_api_url="$(printf '%s\n' "$remote_env_content" | grep -E '^RAG_RERANK_API_URL=' | tail -1 | cut -d= -f2- || true)"
rerank_api_key="$(printf '%s\n' "$remote_env_content" | grep -E '^RAG_RERANK_API_KEY=' | tail -1 | cut -d= -f2- || true)"
rerank_provider="$(remote_env_value RAG_RERANK_PROVIDER)"
rerank_provider="${rerank_provider:-dashscope}"
rerank_model="$(remote_env_value RAG_RERANK_MODEL)"
if [[ "$rerank_provider" == "dashscope" && ( -z "$rerank_model" || "$rerank_model" == "bge-reranker-v2-m3" ) ]]; then
  # Migrate the legacy local-model default to DashScope's hosted rerank model.
  rerank_model="gte-rerank-v2"
else
  rerank_model="${rerank_model:-gte-rerank-v2}"
fi
rerank_api_url="${rerank_api_url:-https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank}"
rerank_api_key="${rerank_api_key:-$llm_api_key}"
agent_reasoning_model="$(remote_env_value AGENT_REASONING_MODEL)"
agent_reasoning_model="${agent_reasoning_model:-$llm_model}"
if [[ -f .env ]]; then
  local_llm_api_key="$(grep -E '^LLM_API_KEY=' .env | tail -1 | cut -d= -f2- || true)"
  local_llm_api="$(grep -E '^LLM_API=' .env | tail -1 | cut -d= -f2- || true)"
  local_llm_base_url="$(grep -E '^LLM_BASE_URL=' .env | tail -1 | cut -d= -f2- || true)"
  local_llm_model="$(grep -E '^LLM_MODEL=' .env | tail -1 | cut -d= -f2- || true)"
  local_use_real_llm="$(grep -E '^USE_REAL_LLM=' .env | tail -1 | cut -d= -f2- || true)"
  local_embed_model="$(grep -E '^EMBED_MODEL=' .env | tail -1 | cut -d= -f2- || true)"
  local_embed_base_url="$(grep -E '^EMBED_BASE_URL=' .env | tail -1 | cut -d= -f2- || true)"
  local_embed_api_key="$(grep -E '^EMBED_API_KEY=' .env | tail -1 | cut -d= -f2- || true)"
  local_embed_batch_size="$(grep -E '^EMBED_BATCH_SIZE=' .env | tail -1 | cut -d= -f2- || true)"
  local_embed_enabled="$(grep -E '^EMBED_ENABLED=' .env | tail -1 | cut -d= -f2- || true)"
  local_rerank_api_url="$(grep -E '^RAG_RERANK_API_URL=' .env | tail -1 | cut -d= -f2- || true)"
  local_rerank_api_key="$(grep -E '^RAG_RERANK_API_KEY=' .env | tail -1 | cut -d= -f2- || true)"
  if [[ "${DEPLOY_USE_LOCAL_LLM_ENV:-0}" == "1" ]]; then
    if [[ -n "$local_llm_api_key" ]]; then llm_api_key="$local_llm_api_key"; fi
    if [[ -n "$local_llm_api" ]]; then llm_api_key="$local_llm_api"; fi
    if [[ -n "$local_llm_base_url" ]]; then llm_base_url="$local_llm_base_url"; fi
    if [[ -n "$local_llm_model" ]]; then llm_model="$local_llm_model"; fi
    if [[ -n "$local_use_real_llm" ]]; then use_real_llm="$local_use_real_llm"; fi
    if [[ -n "$local_embed_model" ]]; then embed_model="$local_embed_model"; fi
    if [[ -n "$local_embed_base_url" ]]; then embed_base_url="$local_embed_base_url"; fi
    if [[ -n "$local_embed_api_key" ]]; then embed_api_key="$local_embed_api_key"; fi
    if [[ -n "$local_embed_batch_size" ]]; then embed_batch_size="$local_embed_batch_size"; fi
    if [[ -n "$local_embed_enabled" ]]; then embed_enabled="$local_embed_enabled"; fi
  fi
  if [[ -n "$local_rerank_api_url" ]]; then
    rerank_api_url="$local_rerank_api_url"
  fi
  if [[ -n "$local_rerank_api_key" ]]; then
    rerank_api_key="$local_rerank_api_key"
  fi
fi

cat > "$TMP_ENV" <<ENV
# Bootstrap defaults for first deployment only.
# Existing server config at $REMOTE_ENV is preserved by scripts/deploy.sh.
SERVER_HOST=0.0.0.0
SERVER_PORT=$DEPLOY_PORT
DOCUMIND_ENV=production

DATABASE_URL=$REMOTE_DATABASE_URL
REDIS_URL=$REMOTE_REDIS_URL
RABBITMQ_URL=$REMOTE_RABBITMQ_URL
ELASTICSEARCH_URL=$REMOTE_ELASTICSEARCH_URL

OBJECT_STORAGE_PROVIDER=minio
OBJECT_STORAGE_ENDPOINT=$REMOTE_MINIO_ENDPOINT
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=documind
OBJECT_STORAGE_ACCESS_KEY=documind
OBJECT_STORAGE_SECRET_KEY=documind
OBJECT_STORAGE_FORCE_PATH_STYLE=true
OBJECT_STORAGE_TLS_VERIFY=false
OBJECT_STORAGE_PRESIGN_EXPIRE_SECONDS=900
BLOB_STORAGE_DIR=$REMOTE_ROOT/shared/objects

LLM_BASE_URL=$llm_base_url
LLM_API=$llm_api_key
LLM_API_KEY=$llm_api_key
LLM_MODEL=$llm_model
USE_REAL_LLM=$use_real_llm

EMBED_MODEL=$embed_model
EMBED_DIM=$embed_dim
EMBED_BASE_URL=$embed_base_url
EMBED_API_KEY=$embed_api_key
EMBED_BATCH_SIZE=$embed_batch_size
EMBED_RETRY_MAX=$embed_retry_max
EMBED_WORKER_POLL_MS=$embed_worker_poll_ms
EMBED_ENABLED=$embed_enabled
ES_INDEX_CHUNKS=$es_index_chunks
ES_INDEX_ALIAS=$es_index_alias
ES_INDEX_SCHEMA_VERSION=$es_index_schema_version

JWT_SECRET=$jwt_secret
AUTH_TOKEN_EXPIRE_HOURS=24
AUTH_LOGIN_MODE=local
PORTAL_MANAGED=false
PORTAL_AUTH_ENABLED=false
PORTAL_BASE_URL=http://127.0.0.1:7777
PORTAL_EXCHANGE_ENDPOINT=/api/auth/exchange-ticket

DEFAULT_TENANT_ID=00000000-0000-0000-0000-000000000001
DEFAULT_USER_ID=00000000-0000-0000-0000-000000000002
DEFAULT_ROLE=enterprise_admin
DEFAULT_KB_IDS=00000000-0000-0000-0000-000000000010,00000000-0000-0000-0000-000000000011,00000000-0000-0000-0000-000000000012
DEFAULT_TENANT_NAME=AcmeCorp
DEFAULT_TENANT_SLUG=acme
SUPER_ADMIN_EMAIL=Anner
SUPER_ADMIN_PASSWORD=1
ENTERPRISE_ADMIN_EMAIL=admin@documind.local
ENTERPRISE_ADMIN_PASSWORD=documind123
STANDARD_USER_EMAIL=user@documind.local
STANDARD_USER_PASSWORD=documind123

RUST_LOG=documind=info,tower_http=info
LOG_FORMAT=json

RAG_REWRITE_ENABLED=true
RAG_HYDE_ENABLED=true
RAG_REWRITE_MODEL=qwen-turbo
RAG_DENSE_TOP_K=100
RAG_BM25_TOP_K=100
RAG_RRF_TOP_K=20
RAG_TOP_K=5
RAG_RERANK_ENABLED=true
RAG_RERANK_PROVIDER=$rerank_provider
RAG_RERANK_MODEL=$rerank_model
RAG_RERANK_API_URL=$rerank_api_url
RAG_RERANK_API_KEY=$rerank_api_key
RAG_REQUIRE_CITATION=true
RAG_VERIFY_CLAIMS=true
RAG_TARGET_CHUNK_TOKENS=800
RAG_MAX_CHUNK_TOKENS=1500
RAG_HARD_SPLIT_TOKENS=2000
RAG_MIN_CHUNK_TOKENS=200
RAG_CHUNK_OVERLAP_TOKENS=200
RAG_MAX_TABLE_ROWS_PER_CHUNK=50
RAG_MAX_TABLE_TOKEN_PER_CHUNK=1200

LLM_TEMPERATURE=0.2
LLM_MAX_OUTPUT_TOKENS=1200

AGENT_DEFAULT_TONE=concise_warm
AGENT_REASONING_MODEL=$agent_reasoning_model
AGENT_PROACTIVE_FOLLOWUP=true
AGENT_MAX_FOLLOWUP_SUGGESTIONS=2
AGENT_ALLOW_ANALYST_MODE=true
AGENT_REQUIRE_CITATION_FOR_ANALYSIS=true
AGENT_CLARIFICATION_STYLE=short
AGENT_MAX_REACT_STEPS=4
AGENT_MAX_QUERIES_PER_STEP=4
AGENT_MAX_HISTORY_TURNS=12
AGENT_MAX_HISTORY_CHARS=24000
AGENT_MAX_CONTEXT_CHARS=30000
AGENT_MAX_REPAIR_ATTEMPTS=3
AGENT_TOTAL_TIMEOUT_SECONDS=240
ENV

echo "Deploying DocuMind to ssh $DEPLOY_HOST"
echo "Release: $RELEASE_ID"
echo "Port: $DEPLOY_PORT"
echo "Binary sha256: $local_sha256"

ssh "$DEPLOY_HOST" "bash -s" <<REMOTE
set -euo pipefail
mkdir -p '$REMOTE_RELEASE/bin' '$REMOTE_SHARED/logs' '$REMOTE_SHARED/runtime' '$REMOTE_SHARED/models'
REMOTE

scp "$LOCAL_BINARY" "$DEPLOY_HOST:$REMOTE_RELEASE/bin/documind"
scp "$TMP_ENV" "$DEPLOY_HOST:$REMOTE_RELEASE/.env.default"

COPYFILE_DISABLE=1 tar -czf - apps/api-rs/migrations | ssh "$DEPLOY_HOST" "mkdir -p '$REMOTE_RELEASE' && tar -xzf - -C '$REMOTE_RELEASE'"

ssh "$DEPLOY_HOST" "bash -s" <<REMOTE
set -euo pipefail

remote_release='$REMOTE_RELEASE'
remote_current='$REMOTE_CURRENT'
remote_shared='$REMOTE_SHARED'
remote_env='$REMOTE_ENV'
remote_log='$REMOTE_LOG'
remote_pid='$REMOTE_PID'
deploy_port='$DEPLOY_PORT'
local_sha256='$local_sha256'
pg_container='$REMOTE_PG_CONTAINER'
redis_container='$REMOTE_REDIS_CONTAINER'
rabbitmq_container='$REMOTE_RABBITMQ_CONTAINER'
es_container='$REMOTE_ES_CONTAINER'
minio_container='$REMOTE_MINIO_CONTAINER'
pg_user='$REMOTE_PG_USER'
pg_database='$REMOTE_PG_DATABASE'
postgres_image='$REMOTE_POSTGRES_IMAGE'
redis_image='$REMOTE_REDIS_IMAGE'
rabbitmq_image='$REMOTE_RABBITMQ_IMAGE'
es_image='$REMOTE_ES_IMAGE'
minio_image='$REMOTE_MINIO_IMAGE'

if [[ ! -f "\$remote_env" ]]; then
  cp "\$remote_release/.env.default" "\$remote_env"
  chmod 600 "\$remote_env"
  echo "Initialized runtime config: \$remote_env"
else
  chmod 600 "\$remote_env"
  echo "Preserving existing runtime config: \$remote_env"
fi

ensure_env_var() {
  local key="\$1"
  local value="\$2"
  if ! grep -qE "^\${key}=" "\$remote_env"; then
    printf '\n%s=%s\n' "\$key" "\$value" >> "\$remote_env"
  fi
}

ensure_env_var DOCUMIND_ENV production

upsert_env_var() {
  local key="\$1"
  local value="\$2"
  local temp_file
  temp_file="\$(mktemp)"
  awk -v key="\$key" -v value="\$value" '
    BEGIN { replaced = 0 }
    index(\$0, key "=") == 1 {
      if (!replaced) print key "=" value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print key "=" value }
  ' "\$remote_env" > "\$temp_file"
  cat "\$temp_file" > "\$remote_env"
  rm -f "\$temp_file"
}

release_env_value() {
  grep -E "^\$1=" "\$remote_release/.env.default" | tail -1 | cut -d= -f2-
}

for required_key in \
  RAG_RERANK_ENABLED RAG_RERANK_PROVIDER RAG_RERANK_MODEL \
  RAG_RERANK_API_URL RAG_RERANK_API_KEY AGENT_REASONING_MODEL \
  AGENT_MAX_REPAIR_ATTEMPTS AGENT_TOTAL_TIMEOUT_SECONDS; do
  upsert_env_var "\$required_key" "\$(release_env_value "\$required_key")"
done
for agent_key in \
  AGENT_MAX_REACT_STEPS AGENT_MAX_QUERIES_PER_STEP AGENT_MAX_HISTORY_TURNS \
  AGENT_MAX_HISTORY_CHARS AGENT_MAX_CONTEXT_CHARS; do
  ensure_env_var "\$agent_key" "\$(release_env_value "\$agent_key")"
done

chmod +x "\$remote_release/bin/documind"
remote_sha256="\$(sha256sum "\$remote_release/bin/documind" | awk '{print \$1}')"
if [[ "\$remote_sha256" != "\$local_sha256" ]]; then
  echo "Uploaded binary checksum mismatch."
  echo "expected: \$local_sha256"
  echo "remote: \$remote_sha256"
  exit 1
fi
printf '%s  %s\n' "\$remote_sha256" "\$remote_release/bin/documind" > "\$remote_release/bin/documind.sha256"
ln -sfn "\$remote_release" "\$remote_current"

mkdir -p \
  "\$remote_shared/postgres" \
  "\$remote_shared/redis" \
  "\$remote_shared/rabbitmq" \
  "\$remote_shared/elasticsearch" \
  "\$remote_shared/minio" \
  "\$remote_shared/objects"
chown -R 1000:0 "\$remote_shared/elasticsearch"
chmod -R g+rwX "\$remote_shared/elasticsearch"

ensure_office_preview_dependencies() {
  if command -v soffice >/dev/null 2>&1 || command -v libreoffice >/dev/null 2>&1; then
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y \
      libreoffice-core \
      libreoffice-writer \
      libreoffice-impress \
      libreoffice-graphicfilter \
      libreoffice-langpack-zh-Hans \
      google-noto-sans-cjk-ttc-fonts >/dev/null
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y \
      libreoffice-core \
      libreoffice-writer \
      libreoffice-impress \
      libreoffice-graphicfilter \
      libreoffice-langpack-zh-Hans \
      google-noto-sans-cjk-ttc-fonts >/dev/null
    return
  fi

  echo "LibreOffice is required for DOCX/PPTX preview conversion, but no supported package manager was found." >&2
  exit 1
}

ensure_ocr_dependencies() {
  if command -v pdftoppm >/dev/null 2>&1 && command -v tesseract >/dev/null 2>&1; then
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y \
      poppler-utils \
      tesseract \
      tesseract-langpack-chi_sim >/dev/null
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y \
      poppler-utils \
      tesseract \
      tesseract-langpack-chi_sim >/dev/null
    return
  fi

  echo "pdftoppm and tesseract are required for OCR enhancement, but no supported package manager was found." >&2
  exit 1
}

ensure_office_preview_dependencies
ensure_ocr_dependencies

container_exists() {
  docker container inspect "\$1" >/dev/null 2>&1
}

container_running() {
  docker ps --format '{{.Names}}' | grep -qx "\$1"
}

if ! container_exists "\$pg_container"; then
  docker run -d --name "\$pg_container" \
    -e POSTGRES_USER=documind \
    -e POSTGRES_PASSWORD=documind \
    -e POSTGRES_DB="\$pg_database" \
    -p 127.0.0.1:8100:5432 \
    -v "\$remote_shared/postgres:/var/lib/postgresql/data" \
    "\$postgres_image" >/dev/null
elif ! container_running "\$pg_container"; then
  docker start "\$pg_container" >/dev/null
fi

if ! container_exists "\$redis_container"; then
  docker run -d --name "\$redis_container" \
    -p 127.0.0.1:8101:6379 \
    -v "\$remote_shared/redis:/data" \
    "\$redis_image" redis-server --appendonly yes >/dev/null
elif ! container_running "\$redis_container"; then
  docker start "\$redis_container" >/dev/null
fi

if ! container_exists "\$rabbitmq_container"; then
  docker run -d --name "\$rabbitmq_container" \
    -p 127.0.0.1:8102:5672 \
    -p 127.0.0.1:8103:15672 \
    -v "\$remote_shared/rabbitmq:/var/lib/rabbitmq" \
    "\$rabbitmq_image" >/dev/null
elif ! container_running "\$rabbitmq_container"; then
  docker start "\$rabbitmq_container" >/dev/null
fi

if ! container_exists "\$es_container"; then
  docker run -d --name "\$es_container" \
    -e discovery.type=single-node \
    -e xpack.security.enabled=false \
    -e ES_JAVA_OPTS='-Xms512m -Xmx512m' \
    -p 127.0.0.1:8104:9200 \
    -v "\$remote_shared/elasticsearch:/usr/share/elasticsearch/data" \
    "\$es_image" >/dev/null
elif ! container_running "\$es_container"; then
  docker start "\$es_container" >/dev/null
fi

if ! container_exists "\$minio_container"; then
  docker run -d --name "\$minio_container" \
    -e MINIO_ROOT_USER=documind \
    -e MINIO_ROOT_PASSWORD=documind \
    -p 127.0.0.1:9010:9000 \
    -p 127.0.0.1:9011:9001 \
    -v "\$remote_shared/minio:/data" \
    "\$minio_image" server /data --console-address ':9001' >/dev/null
elif ! container_running "\$minio_container"; then
  docker start "\$minio_container" >/dev/null
fi

docker exec "\$pg_container" pg_isready -U "\$pg_user" -d "\$pg_database" >/dev/null
docker exec "\$redis_container" redis-cli -n 0 ping >/dev/null
docker exec "\$rabbitmq_container" rabbitmq-diagnostics -q ping >/dev/null
for _ in \$(seq 1 60); do
  if curl -fsS http://127.0.0.1:8104 >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8104 >/dev/null
for _ in \$(seq 1 60); do
  if curl -fsS http://127.0.0.1:9010/minio/health/live >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:9010/minio/health/live >/dev/null
docker exec "\$minio_container" sh -c \
  "mc alias set local http://127.0.0.1:9000 documind documind >/dev/null && mc mb -p local/documind >/dev/null 2>&1 || true"

printf '%s\n' \
  "CREATE SCHEMA IF NOT EXISTS documind AUTHORIZATION \$pg_user;" \
  'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' \
  'CREATE TABLE IF NOT EXISTS documind._deploy_migrations (' \
  '    id TEXT PRIMARY KEY,' \
  '    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()' \
  ');' \
  | docker exec -i "\$pg_container" psql -U "\$pg_user" -d "\$pg_database" >/dev/null

for migration in "\$remote_release"/apps/api-rs/migrations/*.up.sql; do
  migration_id="\$(basename "\$migration")"
  applied="\$(docker exec "\$pg_container" psql -At -U "\$pg_user" -d "\$pg_database" -c "SELECT 1 FROM documind._deploy_migrations WHERE id = '\$migration_id'" || true)"
  if [[ "\$applied" == "1" ]]; then
    continue
  fi
  {
    echo "SET search_path TO documind, public;"
    cat "\$migration"
    echo "INSERT INTO documind._deploy_migrations(id) VALUES ('\$migration_id');"
  } | docker exec -i "\$pg_container" psql -v ON_ERROR_STOP=1 -U "\$pg_user" -d "\$pg_database" >/dev/null
done

if [[ -f "\$remote_pid" ]]; then
  old_pid="\$(cat "\$remote_pid" 2>/dev/null || true)"
  if [[ -n "\$old_pid" ]] && kill -0 "\$old_pid" 2>/dev/null; then
    kill "\$old_pid" || true
    for _ in 1 2 3 4 5; do
      kill -0 "\$old_pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "\$old_pid" 2>/dev/null || true
  fi
fi

if command -v fuser >/dev/null 2>&1; then
  fuser -k "\$deploy_port/tcp" >/dev/null 2>&1 || true
fi

cd "\$remote_shared"
set -a
source "\$remote_env"
set +a

if [[ -f "\$remote_log" ]] && [[ "\$(wc -c < "\$remote_log")" -gt 52428800 ]]; then
  mv "\$remote_log" "\$remote_log.\$(date +%Y%m%d-%H%M%S)"
fi

nohup "\$remote_current/bin/documind" >> "\$remote_log" 2>&1 &
echo "\$!" > "\$remote_pid"
echo "\$local_sha256" > "\$remote_shared/runtime/documind-$DEPLOY_PORT.sha256"

for _ in \$(seq 1 45); do
  if curl -fsS "http://127.0.0.1:\$deploy_port/api/health" >/dev/null 2>&1; then
    echo "DocuMind is running on port \$deploy_port"
    curl -fsS "http://127.0.0.1:\$deploy_port/api/health"
    echo
    exit 0
  fi
  sleep 1
done

echo "DocuMind did not pass health check. Recent log:"
tail -80 "\$remote_log" || true
exit 1
REMOTE
