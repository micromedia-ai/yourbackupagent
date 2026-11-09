#!/usr/bin/env bash
# Runs YourBackupAgent (github.com/micromedia-ai/yourbackupagent) for this
# project: the kit version pinned by KIT_REF in backup.env next to this file,
# with this project's backup.env. Fetched once per version into
# ~/.cache/yourbackupagent/<ref> (needs read access to that repository:
# `gh auth login` or your usual git login). YOURBACKUPAGENT_DIR=<checkout>
# runs a local copy of the kit instead.
#
# Usage: backup-kit/backup.sh <command> [options]   (backup-kit/backup.sh --help)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REF="$(sed -n 's/^KIT_REF=//p' "$HERE/backup.env" | tr -d '"' | tail -n 1)"
REF="${REF:-v1}"
if [ -n "${YOURBACKUPAGENT_DIR:-}" ]; then
  KIT="$YOURBACKUPAGENT_DIR"
else
  KIT="${XDG_CACHE_HOME:-$HOME/.cache}/yourbackupagent/$REF"
  if [ ! -x "$KIT/kit/backup.sh" ]; then
    rm -rf "$KIT.tmp"
    mkdir -p "$(dirname "$KIT")"
    git clone -q --depth 1 --branch "$REF" https://github.com/micromedia-ai/yourbackupagent "$KIT.tmp" \
      || { echo "ERROR: cannot fetch micromedia-ai/yourbackupagent at $REF (log in to GitHub: gh auth login)" >&2; exit 1; }
    rm -rf "$KIT" && mv "$KIT.tmp" "$KIT"
  elif ! [[ "$REF" =~ ^v[0-9] ]]; then
    # A branch moves; a version tag never does.
    git -C "$KIT" fetch -q --depth 1 origin "$REF" && git -C "$KIT" reset -q --hard FETCH_HEAD \
      || echo "WARNING: could not update the kit at $REF; using the copy from $(git -C "$KIT" log -1 --format=%cd)" >&2
  fi
fi
BACKUP_ENV="$HERE/backup.env" KIT_REF_USED="$REF" exec "$KIT/kit/backup.sh" "$@"
