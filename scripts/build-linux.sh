#!/usr/bin/env bash
# 本地交叉构建 Linux x86_64 Bun 单文件二进制（容器内 bun build --compile）。
# 仅用于 make deploy-build；正式发布构建在服务器完成（make deploy-remote）。
set -euo pipefail

TARGET_DIR="${DEPLOY_TARGET_DIR:-dist/linux-x86_64}"
BIN_NAME="${BIN_NAME:-documind}"
BUN_IMAGE="${BUN_BUILD_IMAGE:-m.daocloud.io/docker.io/oven/bun:1.3.14}"
BUN_REGISTRY="${BUN_REGISTRY:-https://registry.npmmirror.com}"

if ! command -v docker >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/docker /usr/local/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker; do
    if [[ -x "$candidate" ]]; then
      PATH="$(dirname "$candidate"):$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to cross-build the Linux deploy binary."
  exit 1
fi

mkdir -p "$TARGET_DIR"

docker run --rm \
  -v "$PWD":/workspace \
  -w /workspace/apps/api-bun \
  -e BUN_CONFIG_REGISTRY="$BUN_REGISTRY" \
  "$BUN_IMAGE" \
  bash -lc "bun install --frozen-lockfile && bun run scripts/gen-web-assets.ts /workspace/apps/web/out && bun build --compile --minify --target=bun-linux-x64 --outfile /workspace/$TARGET_DIR/$BIN_NAME src/index.ts"

echo "$TARGET_DIR/$BIN_NAME"

