#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
base="$(mktemp -d)"
trap 'rm -rf "$base"' EXIT
prune() { bash "$ROOT/scripts/prune-releases.sh" "$base" "$@"; }
release() { printf '%s/releases/2026110%s-010203-012345abcdef' "$base" "$1"; }

for i in 1 2 3 4 5 6 7 8; do mkdir -p "$(release "$i")"; done
mkdir -p "$base/shared" "$base/releases/manual-backup"
printf 'business data\n' > "$base/shared/data"
ln -s "$base/shared" "$base/releases/external-link"

# Missing or out-of-tree current must fail without deleting anything.
if prune; then echo 'Missing current was accepted' >&2; exit 1; fi
test -d "$(release 3)"
ln -s "$base/shared" "$base/current"
if prune; then echo 'Out-of-tree current was accepted' >&2; exit 1; fi
test -d "$(release 3)"
rm "$base/current"

# A rollback to an older release must not make either running or previous release disposable.
ln -s "$(release 1)" "$base/current"
prune "$(release 2)" | grep -F 'removed 1;'
test -d "$(release 1)"
test -d "$(release 2)"
test ! -e "$(release 3)"
for i in 4 5 6 7 8; do test -d "$(release "$i")"; done
test -d "$base/releases/manual-backup"
test -L "$base/releases/external-link"
test "$(< "$base/shared/data")" = 'business data'
prune "$(release 2)" | grep -F 'removed 0;'
test -d "$(release 2)"
echo 'prune-releases: PASS'
