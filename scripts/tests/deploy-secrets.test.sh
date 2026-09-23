#!/usr/bin/env bash
# 回归：部署脚本不得再硬编码弱口令，弱值必须轮换、强值必须复用。
# 用法: bash scripts/tests/deploy-secrets.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/deploy-secrets.sh
source "$ROOT/scripts/lib/deploy-secrets.sh"

pass=0
fail=0
ok() { echo "ok - $1"; pass=$((pass + 1)); }
no() { echo "not ok - $1"; fail=$((fail + 1)); }

assert_rotated() {
  local input="$1" label="$2" out
  out="$(resolve_strong_secret "$input")"
  if [[ ${#out} -eq 32 && "$out" =~ ^[0-9a-f]{32}$ && "$out" != "$input" && "$out" != "1" ]]; then
    ok "弱值 $label 轮换为 32 位随机十六进制"
  else
    no "弱值 $label 未轮换（len=${#out}）"
  fi
}

assert_rotated "" "空值"
assert_rotated "1" "字面量 1"
assert_rotated "short" "过短值"

strong="$(openssl rand -hex 16)"
if [[ "$(resolve_strong_secret "$strong")" == "$strong" ]]; then
  ok "已有强值原样复用"
else
  no "已有强值被改写"
fi

if [[ "$(resolve_strong_secret "1")" != "$(resolve_strong_secret "1")" ]]; then
  ok "两次轮换互不相同"
else
  no "轮换值可预测"
fi

deploy="$ROOT/scripts/deploy.sh"
if grep -qE '^(SUPER_ADMIN_PASSWORD|ENTERPRISE_ADMIN_PASSWORD|STANDARD_USER_PASSWORD)=[^$]' "$deploy"; then
  no "deploy.sh 仍存在硬编码种子口令"
else
  ok "deploy.sh 无硬编码种子口令"
fi
if grep -qE '^SUPER_ADMIN_PASSWORD=1$|documind123' "$deploy"; then
  no "deploy.sh 仍出现 1 / documind123 弱口令字面量"
else
  ok "deploy.sh 无 1 / documind123 弱口令字面量"
fi
for key in SUPER_ADMIN_PASSWORD ENTERPRISE_ADMIN_PASSWORD STANDARD_USER_PASSWORD; do
  if grep -q "resolve_strong_secret \"\$(remote_env_value $key)\"" "$deploy"; then
    ok "deploy.sh 对 $key 调用 resolve_strong_secret"
  else
    no "deploy.sh 未对 $key 调用 resolve_strong_secret"
  fi
done
if grep -q 'SUPER_ADMIN_PASSWORD 仍为弱值，拒绝部署' "$deploy"; then
  ok "deploy.sh 在弱口令残留时拒绝部署"
else
  no "deploy.sh 缺少弱口令兜底校验"
fi

echo "# pass=$pass fail=$fail"
[[ $fail -eq 0 ]]
