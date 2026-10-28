#!/usr/bin/env bash
# 部署口令解析：复用远端已有的强值，弱值（空、"1"、短于 16 位）轮换为随机值。
# 被 scripts/deploy.sh 与 scripts/tests/deploy-secrets.test.sh 共享。

MIN_SECRET_LENGTH=16

random_secret() {
  openssl rand -hex 16 2>/dev/null || date +%s | shasum -a 256 | cut -c1-32
}

is_weak_secret() {
  local value="${1:-}"
  [[ ${#value} -lt $MIN_SECRET_LENGTH || "$value" == "1" ]]
}

resolve_strong_secret() {
  local current="${1:-}"
  if is_weak_secret "$current"; then
    random_secret
    return 0
  fi
  printf '%s' "$current"
}
