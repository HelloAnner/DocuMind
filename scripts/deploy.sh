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

llm_api_key=""
llm_base_url="http://localhost:11434/v1"
llm_model="qwen2.5:14b"
if [[ -f .env ]]; then
  llm_api_key="$(grep -E '^LLM_API_KEY=' .env | tail -1 | cut -d= -f2- || true)"
  llm_base_url="$(grep -E '^LLM_BASE_URL=' .env | tail -1 | cut -d= -f2- || true)"
  llm_model="$(grep -E '^LLM_MODEL=' .env | tail -1 | cut -d= -f2- || true)"
fi

cat > "$TMP_ENV" <<ENV
# Managed by scripts/deploy.sh. Edit on server only when changing runtime config.
SERVER_HOST=0.0.0.0
SERVER_PORT=$DEPLOY_PORT

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
LLM_API_KEY=$llm_api_key
LLM_MODEL=$llm_model
USE_REAL_LLM=false

EMBEDDING_MODEL=bge-large-zh-v1.5
EMBEDDING_DIM=1024
ONNX_MODEL_PATH=$REMOTE_ROOT/shared/models/bge-large-zh-v1.5.onnx

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
DEFAULT_KB_IDS=00000000-0000-0000-0000-000000000010
DEFAULT_TENANT_NAME=AcmeCorp
DEFAULT_TENANT_SLUG=acme
SUPER_ADMIN_EMAIL=ops@documind.local
SUPER_ADMIN_PASSWORD=documind123
ENTERPRISE_ADMIN_EMAIL=Anner
ENTERPRISE_ADMIN_PASSWORD=1
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
RAG_RERANK_MODEL=bge-reranker-v2-m3
RAG_RERANK_THRESHOLD=0.3
RAG_REQUIRE_CITATION=true
RAG_VERIFY_CLAIMS=true
RAG_CHUNK_SIZE=1500
RAG_CHUNK_OVERLAP=200

LLM_TEMPERATURE=0.2
LLM_MAX_OUTPUT_TOKENS=1200

AGENT_DEFAULT_TONE=concise_warm
AGENT_PROACTIVE_FOLLOWUP=true
AGENT_MAX_FOLLOWUP_SUGGESTIONS=2
AGENT_ALLOW_ANALYST_MODE=true
AGENT_REQUIRE_CITATION_FOR_ANALYSIS=true
AGENT_CLARIFICATION_STYLE=short
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
scp "$TMP_ENV" "$DEPLOY_HOST:$REMOTE_ENV"

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

chmod 600 "\$remote_env"
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
