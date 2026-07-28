#!/usr/bin/env bash
set -euo pipefail

UPDATE_ID="${UPDATE_ID:?UPDATE_ID is required}"
UPDATE_TYPE="${UPDATE_TYPE:?UPDATE_TYPE is required}"
BASE_SHA="${BASE_SHA:-}"
TARGET_SHA="${TARGET_SHA:?TARGET_SHA is required}"
UPDATE_ARCHIVE="${UPDATE_ARCHIVE:?UPDATE_ARCHIVE is required}"
UPDATE_ARCHIVE_SHA256="${UPDATE_ARCHIVE_SHA256:?UPDATE_ARCHIVE_SHA256 is required}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/documind}"
REMOTE_BUILD_ROOT="${REMOTE_BUILD_ROOT:-$REMOTE_ROOT/build}"
SOURCE_ROOT="$REMOTE_BUILD_ROOT/source"
STAGING_ROOT="$REMOTE_BUILD_ROOT/source-staging-$UPDATE_ID"
PREVIOUS_ROOT="$REMOTE_BUILD_ROOT/source-previous-$UPDATE_ID"
UPDATE_ROOT="$REMOTE_BUILD_ROOT/update-$UPDATE_ID"
UPDATE_STORE="$REMOTE_BUILD_ROOT/updates"
DEPLOY_LOCK="$REMOTE_ROOT/shared/runtime/deploy.lock"
SOURCE_UPDATE_LOCK="$REMOTE_BUILD_ROOT/source-update.lock"
source_lock_owned=0

cleanup() {
  status="$?"
  if [[ "$source_lock_owned" == "1" ]]; then
    rm -rf "$SOURCE_UPDATE_LOCK"
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "Source update failed; staging data is preserved for inspection." >&2
    echo "Staging: $STAGING_ROOT" >&2
    echo "Update: $UPDATE_ROOT" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -d "$DEPLOY_LOCK" ]]; then
  echo "A deployment is active; refusing to update the server source mirror." >&2
  find "$DEPLOY_LOCK" -maxdepth 1 -type f -print -exec sed -n '1,3p' {} \; 2>/dev/null || true
  exit 1
fi

mkdir -p "$REMOTE_BUILD_ROOT" "$UPDATE_STORE"
if ! mkdir "$SOURCE_UPDATE_LOCK" 2>/dev/null; then
  echo "Another source synchronization owns $SOURCE_UPDATE_LOCK." >&2
  exit 1
fi
source_lock_owned=1

if [[ -d "$DEPLOY_LOCK" ]]; then
  echo "A deployment started while source synchronization was waiting; retry later." >&2
  exit 1
fi

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid target commit: $TARGET_SHA" >&2
  exit 1
fi

actual_sha256="$(sha256sum "$UPDATE_ARCHIVE" | awk '{print $1}')"
if [[ "$actual_sha256" != "$UPDATE_ARCHIVE_SHA256" ]]; then
  echo "Source update checksum mismatch." >&2
  exit 1
fi

if [[ -e "$STAGING_ROOT" || -e "$PREVIOUS_ROOT" || -e "$UPDATE_ROOT" ]]; then
  echo "Update workspace already exists for $UPDATE_ID." >&2
  exit 1
fi

case "$UPDATE_TYPE" in
  full)
    mkdir -p "$STAGING_ROOT"
    tar -xzf "$UPDATE_ARCHIVE" -C "$STAGING_ROOT"
    ;;
  delta)
    if [[ ! "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
      echo "Invalid delta base commit: $BASE_SHA" >&2
      exit 1
    fi
    if [[ ! -f "$SOURCE_ROOT/.documind-source-sha" ]] \
      || [[ "$(cat "$SOURCE_ROOT/.documind-source-sha")" != "$BASE_SHA" ]]; then
      echo "Server source moved since the delta was generated; retry with a full update." >&2
      exit 1
    fi

    mkdir -p "$STAGING_ROOT" "$UPDATE_ROOT"
    cp -a "$SOURCE_ROOT/." "$STAGING_ROOT/"
    tar -xzf "$UPDATE_ARCHIVE" -C "$UPDATE_ROOT"

    if [[ "$(cat "$UPDATE_ROOT/base.sha")" != "$BASE_SHA" ]] \
      || [[ "$(cat "$UPDATE_ROOT/target.sha")" != "$TARGET_SHA" ]]; then
      echo "Delta metadata does not match the requested source transition." >&2
      exit 1
    fi

    tar -xzf "$UPDATE_ROOT/payload.tar.gz" -C "$STAGING_ROOT"
    STAGING_ROOT="$STAGING_ROOT" DELETED_PATHS="$UPDATE_ROOT/deleted-paths.bin" python3 - <<'PY'
import os
from pathlib import Path, PurePosixPath

root = Path(os.environ["STAGING_ROOT"]).resolve()
deletions = Path(os.environ["DELETED_PATHS"]).read_bytes().split(b"\0")

for raw_path in deletions:
    if not raw_path:
        continue
    path_text = raw_path.decode("utf-8")
    relative = PurePosixPath(path_text)
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit(f"unsafe deletion path: {path_text}")
    target = root.joinpath(*relative.parts)
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.exists():
        raise SystemExit(f"refusing to delete non-file path: {path_text}")

    parent = target.parent
    while parent != root:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
PY
    ;;
  *)
    echo "Unsupported source update type: $UPDATE_TYPE" >&2
    exit 1
    ;;
esac

printf '%s\n' "$TARGET_SHA" > "$STAGING_ROOT/.documind-source-sha"

if [[ ! -f "$STAGING_ROOT/Makefile" \
  || ! -x "$STAGING_ROOT/scripts/server-build-deploy.sh" \
  || ! -x "$STAGING_ROOT/scripts/deploy.sh" ]]; then
  echo "Updated source is missing the server deployment entry points." >&2
  exit 1
fi

if [[ -e "$SOURCE_ROOT" ]]; then
  mv "$SOURCE_ROOT" "$PREVIOUS_ROOT"
fi
if ! mv "$STAGING_ROOT" "$SOURCE_ROOT"; then
  if [[ -e "$PREVIOUS_ROOT" ]]; then
    mv "$PREVIOUS_ROOT" "$SOURCE_ROOT"
  fi
  exit 1
fi

rm -rf "$PREVIOUS_ROOT" "$UPDATE_ROOT"
mv "$UPDATE_ARCHIVE" "$UPDATE_STORE/$UPDATE_ID-$UPDATE_TYPE.tar.gz"
rm -rf "$SOURCE_UPDATE_LOCK"
source_lock_owned=0
trap - EXIT

echo "Server source mirror updated"
echo "Source: $SOURCE_ROOT"
echo "Commit: $TARGET_SHA"
echo "Update type: $UPDATE_TYPE"
