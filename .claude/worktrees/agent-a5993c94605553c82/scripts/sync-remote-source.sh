#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-documind}"
DEPLOY_PORT="${DEPLOY_PORT:-8089}"
DEPLOY_BASE_PATH="${DEPLOY_BASE_PATH:-/documind}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/documind}"
REMOTE_BUILD_ROOT="${REMOTE_BUILD_ROOT:-$REMOTE_ROOT/build}"
REMOTE_SOURCE_ROOT="$REMOTE_BUILD_ROOT/source"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
TRIGGER_DEPLOY=0

if [[ "${1:-}" == "--deploy" ]]; then
  TRIGGER_DEPLOY=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--deploy]" >&2
  exit 1
fi

if [[ "$DEPLOY_HOST" != "documind" && "${ALLOW_CUSTOM_DEPLOY_HOST:-0}" != "1" ]]; then
  echo "Refusing non-default deploy host: $DEPLOY_HOST" >&2
  echo "Set ALLOW_CUSTOM_DEPLOY_HOST=1 to override ssh documind." >&2
  exit 1
fi

REPOSITORY_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPOSITORY_ROOT"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Source synchronization requires a clean tracked worktree." >&2
  echo "Commit the exact source that should be synchronized first." >&2
  exit 1
fi

SOURCE_SHA="$(git rev-parse HEAD)"
SOURCE_SHA_SHORT="$(git rev-parse --short=12 HEAD)"
UPDATE_ID="$(date +%Y%m%d-%H%M%S)-$SOURCE_SHA_SHORT"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is required to verify the pushed deployment commit." >&2
  exit 1
fi
ORIGIN_URL="$(git remote get-url origin)"
case "$ORIGIN_URL" in
  https://github.com/*)
    REPOSITORY_NAME="${ORIGIN_URL#https://github.com/}"
    ;;
  ssh://git@ssh.github.com:443/*)
    REPOSITORY_NAME="${ORIGIN_URL#ssh://git@ssh.github.com:443/}"
    ;;
  git@github.com:*|git@ssh.github.com:*)
    REPOSITORY_NAME="${ORIGIN_URL#*:}"
    ;;
  *)
    echo "Cannot derive a GitHub repository from origin: $ORIGIN_URL" >&2
    exit 1
    ;;
esac
REPOSITORY_NAME="${REPOSITORY_NAME%.git}"

PUSHED_SHA=""
for attempt in 1 2 3; do
  PUSHED_SHA="$(
    GH_HTTP_TIMEOUT=120 \
      gh api "repos/$REPOSITORY_NAME/git/ref/heads/$DEPLOY_BRANCH" --jq .object.sha \
      2>/dev/null || true
  )"
  if [[ -n "$PUSHED_SHA" ]]; then
    break
  fi
  echo "GitHub SHA verification attempt $attempt failed; retrying." >&2
done
if [[ -z "$PUSHED_SHA" ]]; then
  echo "Unable to verify the pushed GitHub commit after 3 attempts." >&2
  exit 1
fi
if [[ "$PUSHED_SHA" != "$SOURCE_SHA" ]]; then
  echo "Refusing to synchronize an unpushed or non-main commit." >&2
  echo "Local HEAD: $SOURCE_SHA" >&2
  echo "GitHub $DEPLOY_BRANCH: $PUSHED_SHA" >&2
  exit 1
fi

TEMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

REMOTE_SOURCE_SHA="$(
  ssh "$DEPLOY_HOST" \
    "test -f '$REMOTE_SOURCE_ROOT/.documind-source-sha' && cat '$REMOTE_SOURCE_ROOT/.documind-source-sha' || true"
)"

if [[ "$REMOTE_SOURCE_SHA" == "$SOURCE_SHA" ]]; then
  echo "Server source is already current: $SOURCE_SHA"
else
  UPDATE_TYPE="full"
  BASE_SHA=""
  LOCAL_UPDATE="$TEMP_ROOT/source.tar.gz"

  if [[ "$REMOTE_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] \
    && git cat-file -e "$REMOTE_SOURCE_SHA^{commit}" 2>/dev/null; then
    UPDATE_TYPE="delta"
    BASE_SHA="$REMOTE_SOURCE_SHA"
    CHANGED_PATHS="$TEMP_ROOT/changed-paths.bin"
    DELETED_PATHS="$TEMP_ROOT/deleted-paths.bin"
    PAYLOAD_ARCHIVE="$TEMP_ROOT/payload.tar.gz"
    PACKAGE_ROOT="$TEMP_ROOT/package"
    LOCAL_UPDATE="$TEMP_ROOT/source-delta.tar.gz"
    mkdir -p "$PACKAGE_ROOT"
    : > "$CHANGED_PATHS"
    : > "$DELETED_PATHS"

    while IFS= read -r -d '' status && IFS= read -r -d '' path; do
      case "${status:0:1}" in
        A|M|T)
          printf '%s\0' "$path" >> "$CHANGED_PATHS"
          ;;
        D)
          printf '%s\0' "$path" >> "$DELETED_PATHS"
          ;;
        *)
          echo "Unsupported Git delta status '$status' for '$path'." >&2
          exit 1
          ;;
      esac
    done < <(git diff --name-status -z --no-renames "$BASE_SHA" "$SOURCE_SHA")

    COPYFILE_DISABLE=1 tar -czf "$PAYLOAD_ARCHIVE" --null -T "$CHANGED_PATHS"
    cp "$PAYLOAD_ARCHIVE" "$PACKAGE_ROOT/payload.tar.gz"
    cp "$DELETED_PATHS" "$PACKAGE_ROOT/deleted-paths.bin"
    printf '%s\n' "$BASE_SHA" > "$PACKAGE_ROOT/base.sha"
    printf '%s\n' "$SOURCE_SHA" > "$PACKAGE_ROOT/target.sha"
    COPYFILE_DISABLE=1 tar -czf "$LOCAL_UPDATE" -C "$PACKAGE_ROOT" .
  else
    git archive --format=tar.gz HEAD > "$LOCAL_UPDATE"
  fi

  UPDATE_SHA256="$(sha256_file "$LOCAL_UPDATE")"
  REMOTE_UPDATE="$REMOTE_BUILD_ROOT/incoming/$UPDATE_ID-$UPDATE_TYPE.tar.gz"

  echo "Synchronizing committed source with scp compression"
  echo "Update type: $UPDATE_TYPE"
  echo "Source commit: $SOURCE_SHA"
  if [[ "$UPDATE_TYPE" == "delta" ]]; then
    echo "Base commit: $BASE_SHA"
  fi
  echo "Payload: $(du -h "$LOCAL_UPDATE" | awk '{print $1}')"

  ssh "$DEPLOY_HOST" "mkdir -p '$REMOTE_BUILD_ROOT/incoming'"
  scp -C "$LOCAL_UPDATE" "$DEPLOY_HOST:$REMOTE_UPDATE"
  ssh "$DEPLOY_HOST" \
    "UPDATE_ID='$UPDATE_ID' UPDATE_TYPE='$UPDATE_TYPE' BASE_SHA='$BASE_SHA' TARGET_SHA='$SOURCE_SHA' UPDATE_ARCHIVE='$REMOTE_UPDATE' UPDATE_ARCHIVE_SHA256='$UPDATE_SHA256' REMOTE_ROOT='$REMOTE_ROOT' REMOTE_BUILD_ROOT='$REMOTE_BUILD_ROOT' bash -s" \
    < scripts/apply-source-update.sh
fi

if [[ "$TRIGGER_DEPLOY" == "1" ]]; then
  echo "Triggering server-side make deploy"
  ssh "$DEPLOY_HOST" \
    "cd '$REMOTE_SOURCE_ROOT' && DEPLOY_PORT='$DEPLOY_PORT' DEPLOY_BASE_PATH='$DEPLOY_BASE_PATH' REMOTE_ROOT='$REMOTE_ROOT' make deploy"
fi
