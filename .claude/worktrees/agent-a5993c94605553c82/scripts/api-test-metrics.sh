#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://123.57.255.204:8089}"

metrics="$(curl -fsS "$BASE_URL/api/metrics")"

need_metric() {
  local pattern="$1"
  if ! grep -Eq "$pattern" <<<"$metrics"; then
    echo "missing metric pattern: $pattern" >&2
    exit 1
  fi
}

need_metric '^# TYPE documind_up gauge$'
need_metric '^documind_up 1$'
need_metric '^documind_dependency_up\{dependency="postgres"\} 1$'
need_metric '^documind_dependency_up\{dependency="redis"\} 1$'
need_metric '^documind_dependency_up\{dependency="elasticsearch"\} 1$'
need_metric '^documind_dependency_up\{dependency="object_storage"\} 1$'
need_metric '^documind_dependency_up\{dependency="rabbitmq"\} 1$'
need_metric '^documind_dependency_up\{dependency="real_llm"\} 1$'
need_metric '^documind_dependency_up\{dependency="embedding"\} 1$'
need_metric '^documind_database_metrics_available 1$'
need_metric '^documind_documents_total [0-9]+$'
need_metric '^documind_documents_by_status_total\{status="indexed"\} [0-9]+$'
need_metric '^documind_document_chunks_total [0-9]+$'
need_metric '^documind_parse_jobs_by_status_total\{status="completed"\} [0-9]+$'
need_metric '^documind_conversations_total [0-9]+$'
need_metric '^documind_messages_by_role_total\{role="assistant"\} [0-9]+$'
need_metric '^documind_feedback_total [0-9]+$'

echo "metrics smoke passed: $BASE_URL/api/metrics"
