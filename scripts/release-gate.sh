#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://123.57.255.204:8089}"
GOLDEN_LIMIT="${GOLDEN_LIMIT:-3}"
RUN_CORE_API="${RUN_CORE_API:-1}"
RUN_GOLDEN="${RUN_GOLDEN:-1}"
RUN_PREVIEW_OCR="${RUN_PREVIEW_OCR:-1}"
RUN_BROWSER="${RUN_BROWSER:-1}"
RUN_METRICS="${RUN_METRICS:-1}"

run_step() {
  local name="$1"
  shift
  echo
  echo "== $name =="
  "$@"
}

run_step "server health" make health

if [[ "$RUN_METRICS" == "1" ]]; then
  run_step "metrics smoke" env BASE_URL="$BASE_URL" scripts/api-test-metrics.sh
fi

if [[ "$RUN_CORE_API" == "1" ]]; then
  run_step "core API smoke" env BASE_URL="$BASE_URL" scripts/api-test-conversation.py
fi

if [[ "$RUN_GOLDEN" == "1" ]]; then
  run_step "golden smoke" env BASE_URL="$BASE_URL" scripts/eval-golden.py \
    --limit "$GOLDEN_LIMIT" \
    --output "/tmp/documind-golden-release-gate.json"
fi

if [[ "$RUN_PREVIEW_OCR" == "1" ]]; then
  run_step "Office/OCR/preview-token smoke" env BASE_URL="$BASE_URL" scripts/api-test-preview-ocr.py
fi

if [[ "$RUN_BROWSER" == "1" ]]; then
  run_step "browser FileView smoke" env BASE_URL="$BASE_URL" scripts/browser-test-fileview.sh
fi

echo
echo "release gate passed: $BASE_URL"
