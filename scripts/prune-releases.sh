#!/usr/bin/env bash
set -euo pipefail

base="${1:?Usage: $0 ROOT [PREVIOUS_RELEASE]}"
releases="$(cd "$base/releases" && pwd -P)"
current="$(cd "$base/current" && pwd -P)"
[[ "${current%/*}" == "$releases" ]] || { echo 'Current release is outside releases; refusing cleanup' >&2; exit 1; }
previous="${2:-}"
if [[ -n "$previous" ]]; then previous="$(cd "$previous" && pwd -P)"; fi
kept=0
removed=0
while IFS= read -r release; do
  # Only generated deployment directories; never shared data, symlinks or manual backups.
  [[ "${release##*/}" =~ ^[0-9]{8}-[0-9]{6}(-[0-9a-f]{12})?$ ]] || continue
  kept=$((kept + 1))
  [[ $kept -le 5 || "$release" == "$current" || "$release" == "$previous" ]] && continue
  rm -rf -- "$release"
  removed=$((removed + 1))
done < <(find "$releases" -mindepth 1 -maxdepth 1 -type d | LC_ALL=C sort -r)
echo "DocuMind release cleanup: removed $removed; kept newest five, current and rollback"
