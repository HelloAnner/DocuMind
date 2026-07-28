#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PORT="${DEPLOY_PORT:-8089}"
DEPLOY_BASE_PATH="${DEPLOY_BASE_PATH:-/documind}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/documind}"
REMOTE_BUILD_ROOT="${REMOTE_BUILD_ROOT:-$REMOTE_ROOT/build}"
CANONICAL_SOURCE="$REMOTE_BUILD_ROOT/source"
CACHE_ROOT="$REMOTE_BUILD_ROOT/cache"
NPM_CACHE="$CACHE_ROOT/npm"
CARGO_HOME_CACHE="$CACHE_ROOT/cargo-home"
CARGO_TARGET_CACHE="$CACHE_ROOT/cargo-target"
BUILD_STORE="$REMOTE_BUILD_ROOT/builds"
DEPLOY_LOCK="$REMOTE_ROOT/shared/runtime/deploy.lock"
SOURCE_UPDATE_LOCK="$REMOTE_BUILD_ROOT/source-update.lock"
NODE_IMAGE="${NODE_BUILD_IMAGE:-m.daocloud.io/docker.io/library/node:22-bookworm-slim}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
RUST_IMAGE="${RUST_BUILD_IMAGE:-localhost/documind-rust-musl-build:1.91-bookworm}"
RUST_BASE_IMAGE="${RUST_BASE_IMAGE:-m.daocloud.io/docker.io/library/rust:1.91-bookworm}"
RUST_BUILD_JOBS="${RUST_BUILD_JOBS:-4}"
DEPLOY_TARGET="x86_64-unknown-linux-musl"

current_source="$(pwd -P)"
expected_source="$(cd "$CANONICAL_SOURCE" 2>/dev/null && pwd -P || true)"
if [[ -z "$expected_source" || "$current_source" != "$expected_source" ]]; then
  echo "make deploy is a server-only command." >&2
  echo "Run it from $CANONICAL_SOURCE on ssh documind." >&2
  echo "From a development checkout, use: make deploy-remote" >&2
  exit 1
fi

if [[ ! -f "$CANONICAL_SOURCE/.documind-source-sha" ]]; then
  echo "Missing server source commit marker." >&2
  exit 1
fi
SOURCE_SHA="$(cat "$CANONICAL_SOURCE/.documind-source-sha")"
if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid server source commit marker: $SOURCE_SHA" >&2
  exit 1
fi

SOURCE_SHA_SHORT="${SOURCE_SHA:0:12}"
BUILD_ID="${BUILD_ID:-$(date +%Y%m%d-%H%M%S)-$SOURCE_SHA_SHORT}"
RELEASE_ID="${RELEASE_ID:-$BUILD_ID}"
WORK_ROOT="$REMOTE_BUILD_ROOT/work/$BUILD_ID"
SOURCE_ROOT="$WORK_ROOT/source"
BUILD_METADATA="$BUILD_STORE/$BUILD_ID"
DEPLOY_BINARY="$CARGO_TARGET_CACHE/$DEPLOY_TARGET/release/documind"
phase="building"
succeeded=0

mkdir -p "$REMOTE_ROOT/shared/runtime"
if [[ -d "$SOURCE_UPDATE_LOCK" ]]; then
  echo "The server source mirror is currently being updated; retry later." >&2
  exit 1
fi
if ! mkdir "$DEPLOY_LOCK" 2>/dev/null; then
  echo "Another DocuMind deployment owns $DEPLOY_LOCK." >&2
  find "$DEPLOY_LOCK" -maxdepth 1 -type f -print -exec sed -n '1,3p' {} \; 2>/dev/null || true
  exit 1
fi
if [[ -d "$SOURCE_UPDATE_LOCK" ]]; then
  rm -rf "$DEPLOY_LOCK"
  echo "A source update started while the deployment was waiting; retry later." >&2
  exit 1
fi
printf '%s\n' "$CANONICAL_SOURCE" > "$DEPLOY_LOCK/source"
printf '%s\n' "$SOURCE_SHA" > "$DEPLOY_LOCK/commit"
printf '%s\n' "$BUILD_ID" > "$DEPLOY_LOCK/build-id"
printf '%s\n' "$(date -Iseconds)" > "$DEPLOY_LOCK/started-at"

finish() {
  status="$?"
  if [[ "$succeeded" == "1" ]]; then
    rm -rf "$WORK_ROOT" "$DEPLOY_LOCK"
  elif [[ "$phase" == "building" ]]; then
    rm -rf "$DEPLOY_LOCK"
    echo "Server build failed before deployment; workspace preserved: $WORK_ROOT" >&2
  else
    printf '%s\n' "failed" > "$DEPLOY_LOCK/status"
    echo "Deployment failed after service installation started." >&2
    echo "Workspace and deployment lock are preserved for recovery." >&2
  fi
  exit "$status"
}
trap finish EXIT

if [[ -e "$WORK_ROOT" ]]; then
  echo "Build workspace already exists: $WORK_ROOT" >&2
  exit 1
fi

mkdir -p \
  "$SOURCE_ROOT" \
  "$NPM_CACHE" \
  "$CARGO_HOME_CACHE" \
  "$CARGO_TARGET_CACHE" \
  "$BUILD_METADATA"
cp -a "$CANONICAL_SOURCE/." "$SOURCE_ROOT/"

if [[ ! -f "$SOURCE_ROOT/Cargo.lock" || ! -f "$SOURCE_ROOT/apps/web/package-lock.json" ]]; then
  echo "Server source mirror is incomplete." >&2
  exit 1
fi

if ! docker image inspect "$NODE_IMAGE" >/dev/null 2>&1; then
  docker pull "$NODE_IMAGE"
fi

echo "Building Next.js static export on the server"
docker run --rm \
  -v "$SOURCE_ROOT:/workspace:Z" \
  -v "$NPM_CACHE:/root/.npm:Z" \
  -w /workspace/apps/web \
  -e DOCUMIND_STATIC_EXPORT=1 \
  -e DOCUMIND_BASE_PATH="$DEPLOY_BASE_PATH" \
  -e NEXT_PUBLIC_API_BASE="$DEPLOY_BASE_PATH" \
  -e NPM_CONFIG_REGISTRY="$NPM_REGISTRY" \
  "$NODE_IMAGE" \
  bash -lc 'npm ci && npm run build'

if ! docker image inspect "$RUST_IMAGE" >/dev/null 2>&1; then
  if ! docker image inspect "$RUST_BASE_IMAGE" >/dev/null 2>&1; then
    docker pull "$RUST_BASE_IMAGE"
  fi

  echo "Building reusable Rust musl image: $RUST_IMAGE"
  docker build -t "$RUST_IMAGE" - <<DOCKERFILE
FROM $RUST_BASE_IMAGE
ENV RUSTUP_DIST_SERVER=https://rsproxy.cn \
    RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|https://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://security.debian.org/debian-security|https://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Retries=3 update \
  && apt-get -o Acquire::Retries=3 install -y --no-install-recommends cmake git linux-libc-dev musl-tools pkg-config \
  && rustup target add x86_64-unknown-linux-musl \
  && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

cat > "$CARGO_HOME_CACHE/config.toml" <<'CARGO_CONFIG'
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
retry = 3
CARGO_CONFIG

echo "Building native Linux/musl binary on the server"
docker run --rm \
  -v "$SOURCE_ROOT:/workspace:Z" \
  -v "$CARGO_HOME_CACHE:/cargo-home:Z" \
  -v "$CARGO_TARGET_CACHE:/cargo-target:Z" \
  -w /workspace \
  -e CARGO_HOME=/cargo-home \
  -e CARGO_TARGET_DIR=/cargo-target \
  -e CARGO_BUILD_JOBS="$RUST_BUILD_JOBS" \
  -e CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-linux-musl-gcc \
  -e CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=+crt-static -C relocation-model=static" \
  "$RUST_IMAGE" \
  cargo build --release -p documind --target "$DEPLOY_TARGET"

binary_info="$(file "$DEPLOY_BINARY")"
if ! grep -qi 'ELF.*x86-64' <<<"$binary_info"; then
  echo "Server build did not produce a Linux x86_64 binary: $binary_info" >&2
  exit 1
fi
if grep -qi 'interpreter ' <<<"$binary_info"; then
  echo "Server build binary is not fully static: $binary_info" >&2
  exit 1
fi

binary_sha256="$(sha256sum "$DEPLOY_BINARY" | awk '{print $1}')"
printf '%s\n' "$SOURCE_SHA" > "$BUILD_METADATA/source.sha"
printf '%s\n' "$binary_sha256" > "$BUILD_METADATA/binary.sha256"
printf '%s\n' "$RELEASE_ID" > "$BUILD_METADATA/release-id"

phase="deploying"
echo "Installing server-built release"
(
  cd "$SOURCE_ROOT"
  DEPLOY_LOCAL_SERVER=1 \
    DEPLOY_PORT="$DEPLOY_PORT" \
    RELEASE_ID="$RELEASE_ID" \
    REMOTE_ROOT="$REMOTE_ROOT" \
    LOCAL_BINARY="$DEPLOY_BINARY" \
    scripts/deploy.sh
)

printf '%s\n' "$SOURCE_SHA" > "$REMOTE_ROOT/releases/$RELEASE_ID/source.sha"
printf '%s\n' "$BUILD_ID" > "$REMOTE_ROOT/releases/$RELEASE_ID/build-id"
succeeded=1
trap - EXIT
rm -rf "$WORK_ROOT" "$DEPLOY_LOCK"

echo "Server build and deployment completed"
echo "Release: $RELEASE_ID"
echo "Source commit: $SOURCE_SHA"
echo "Binary sha256: $binary_sha256"
