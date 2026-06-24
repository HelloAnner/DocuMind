#!/usr/bin/env bash
set -euo pipefail

TARGET="${DEPLOY_TARGET:-x86_64-unknown-linux-musl}"
TARGET_DIR="${DEPLOY_TARGET_DIR:-target/deploy-linux-x86_64-musl}"
BIN_NAME="${BIN_NAME:-documind}"
RUSTFLAGS_VALUE="${DEPLOY_TARGET_RUSTFLAGS:--C target-feature=+crt-static -C relocation-model=static}"
CROSS_PLATFORM="${CROSS_DOCKER_PLATFORM:-linux/amd64}"
CROSS_IMAGE_NAME="${CROSS_BUILD_IMAGE:-localhost/documind-rust-musl-cross:1.91-bookworm}"
CROSS_BASE_IMAGE_NAME="${CROSS_BASE_IMAGE:-rust:1.91-bookworm}"
DOCKER_IO_MIRROR_PREFIX="${DOCKER_IO_MIRROR_PREFIX:-m.daocloud.io/docker.io/}"

if ! command -v docker >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/docker /usr/local/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker; do
    if [[ -x "$candidate" ]]; then
      PATH="$(dirname "$candidate"):$PATH"
      export PATH
      break
    fi
  done
fi

docker_io_image() {
  local image="$1"
  local first_part="${image%%/*}"

  if [[ "$image" == docker.io/* ]]; then
    echo "${DOCKER_IO_MIRROR_PREFIX}${image#docker.io/}"
    return
  fi

  if [[ "$image" != */* || ( "$first_part" != *.* && "$first_part" != *:* && "$first_part" != "localhost" ) ]]; then
    echo "${DOCKER_IO_MIRROR_PREFIX}${image}"
    return
  fi

  echo "$image"
}

mkdir -p "$TARGET_DIR"

if command -v cargo-zigbuild >/dev/null 2>&1; then
  echo "Building Linux deploy binary with cargo-zigbuild."
  CARGO_TARGET_DIR="$TARGET_DIR" \
    RUSTFLAGS="$RUSTFLAGS_VALUE" \
    cargo zigbuild --release -p "$BIN_NAME" --target "$TARGET"
  echo "$TARGET_DIR/$TARGET/release/$BIN_NAME"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker or cargo-zigbuild is required to cross-compile the Linux deploy binary."
  exit 1
fi

mkdir -p target/cargo-home "$TARGET_DIR"
CROSS_IMAGE="$(docker_io_image "$CROSS_IMAGE_NAME")"
CROSS_BASE_IMAGE="$(docker_io_image "$CROSS_BASE_IMAGE_NAME")"

if [[ "$CROSS_IMAGE_NAME" == localhost/documind-rust-musl-cross:* ]] && ! docker image inspect "$CROSS_IMAGE" >/dev/null 2>&1; then
  if ! docker image inspect "$CROSS_BASE_IMAGE" >/dev/null 2>&1; then
    echo "Pulling Rust base image: $CROSS_BASE_IMAGE"
    docker pull --platform "$CROSS_PLATFORM" "$CROSS_BASE_IMAGE"
  fi

  echo "Building local Rust musl cross image: $CROSS_IMAGE"
  docker build --platform "$CROSS_PLATFORM" -t "$CROSS_IMAGE" - <<DOCKERFILE
FROM $CROSS_BASE_IMAGE
ENV RUSTUP_DIST_SERVER=https://rsproxy.cn \
    RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
RUN apt-get update \
  && apt-get install -y --no-install-recommends cmake linux-libc-dev musl-tools \
  && rustup target add x86_64-unknown-linux-musl \
  && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

docker run --rm \
  --platform "$CROSS_PLATFORM" \
  -u "$(id -u):$(id -g)" \
  -e CARGO_HOME=/workspace/target/cargo-home \
  -e CARGO_TARGET_DIR=/workspace/"$TARGET_DIR" \
  -e CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-linux-musl-gcc \
  -e CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="$RUSTFLAGS_VALUE" \
  -v "$PWD":/workspace \
  -w /workspace \
  "$CROSS_IMAGE" \
  cargo build --release -p "$BIN_NAME" --target "$TARGET"

echo "$TARGET_DIR/$TARGET/release/$BIN_NAME"
