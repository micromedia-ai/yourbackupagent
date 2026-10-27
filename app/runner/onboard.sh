#!/usr/bin/env bash
# "Set it up here" (the manager app's Protect page): the one-time setup of a
# project, done by the kit runner instead of onboard.sh on a Mac. entry.sh runs
# it from the kit checkout with a project owner's short-lived browser sign-in
# (and the vault owner's, when that is another account):
#   BACKUP_ENV         the project's backup.env from the pull request branch
#   KIT                kit/backup.sh of the same checkout
#   REPO, BRANCH       the repository and its yourbackupagent/protect branch
#   ACCESS_TOKEN_FILE  ACCESS_EMAIL  the project owner's sign-in
#   VAULT_ACCESS_TOKEN_FILE (optional) the vault owner's sign-in; else the same
#   RUNNER_SA          this runner, which gets the access the app needs
#   GH_TOKEN           the app's GitHub token (commits to BRANCH)
# Steps: GitHub sign-in without a key (Workload Identity), commit CI_SA and
# the workflow's sign-in to BRANCH, setup, protect, offsite, the app's access,
# the first backup. Every step can run again. Prints ids and counts only.
set -uo pipefail
: "${BACKUP_ENV:?}" "${KIT:?}" "${REPO:?}" "${BRANCH:?}" "${ACCESS_TOKEN_FILE:?}" "${RUNNER_SA:?}" "${GH_TOKEN:?}"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "bad REPO" >&2; exit 2; }
[[ "$BRANCH" =~ ^[A-Za-z0-9_./-]+$ ]] || { echo "bad BRANCH" >&2; exit 2; }
export VAULT_ACCESS_TOKEN_FILE="${VAULT_ACCESS_TOKEN_FILE:-$ACCESS_TOKEN_FILE}"
export ACCESS_TOKEN_FILE ACCESS_EMAIL BACKUP_ENV

step() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
envv() { sed -n "s/^$1=//p" "$BACKUP_ENV" | tail -n 1 | tr -d '"'; }
setenv() {
  if grep -q "^$1=" "$BACKUP_ENV"; then sed -i "s|^$1=.*|$1=$2|" "$BACKUP_ENV"; else printf '%s=%s\n' "$1" "$2" >>"$BACKUP_ENV"; fi
}
kit() { "$KIT" "$@" --yes; }
# Plain gcloud acts as the project owner (CLOUDSDK_AUTH_ACCESS_TOKEN_FILE), gv as the vault owner.
owner() { CLOUDSDK_AUTH_ACCESS_TOKEN_FILE="$ACCESS_TOKEN_FILE" gcloud "$@"; }
gv() { gcloud --access-token-file="$VAULT_ACCESS_TOKEN_FILE" "$@"; }
bind_bucket() { # bind_bucket <as> <bucket> <member> <role...>
  local as="$1" b="$2" m="$3" r; shift 3
  for r in "$@"; do "$as" storage buckets add-iam-policy-binding "gs://$b" --member="$m" --role="$r" --quiet --format=none || die "could not grant $r on gs://$b"; done
}
# commit <path in repo> <local file> <message>: one file on BRANCH.
commit() {
  local sha body
  sha="$(gh api "repos/$REPO/contents/$1?ref=$BRANCH" --jq .sha 2>/dev/null || true)"
  body="$(jq -n --arg m "$3" --arg c "$(base64 -w0 <"$2")" --arg b "$BRANCH" --arg s "$sha" \
    '{message: $m, content: $c, branch: $b} + (if $s == "" then {} else {sha: $s} end)')"
  gh api -X PUT "repos/$REPO/contents/$1" --input - <<<"$body" >/dev/null || die "could not commit $1 to $BRANCH"
  printf '  committed %s to %s\n' "$1" "$BRANCH"
}

PROJECT_ID="$(envv PROJECT_ID)"
[ -n "$PROJECT_ID" ] || die "no PROJECT_ID in backup.env"
printf 'Setting up %s (%s) as %s\n' "$PROJECT_ID" "$REPO" "${ACCESS_EMAIL:-the project owner}"

step "1/7 GitHub signs in to Google without a key (Workload Identity)"
out="$(kit github-access)" || { printf '%s\n' "$out"; die "github-access failed"; }
printf '%s\n' "$out"
CI_SA="$(sed -n 's/^CI_SA=//p' <<<"$out" | tail -n 1)"
PROVIDER="$(sed -n 's/^WIF_PROVIDER=//p' <<<"$out" | tail -n 1)"
[ -n "$CI_SA" ] && [ -n "$PROVIDER" ] || die "github-access printed no CI_SA/WIF_PROVIDER"
setenv CI_SA "$CI_SA"

step "2/7 The pull request: CI_SA and the workflow's sign-in"
commit backup-kit/backup.env "$BACKUP_ENV" "Backups: CI_SA $CI_SA"
# keyless <workflow>: switch one workflow on BRANCH to Workload Identity
# (adds id-token: write); a missing optional one is skipped.
keyless() {
  local wf="$1" f
  f="$(mktemp)"
  if ! gh api "repos/$REPO/contents/.github/workflows/$wf?ref=$BRANCH" --jq .content 2>/dev/null | base64 -d >"$f" || [ ! -s "$f" ]; then
    [ "${2:-}" = optional ] && return 0
    die "no .github/workflows/$wf on $BRANCH"
  fi
  awk -v p="$PROVIDER" -v sa="$CI_SA" '
    /^permissions:/ { print; inperm = 1; next }
    inperm && /^  id-token:/ { idtok = 1 }
    inperm && !/^  / { if (!idtok) print "  id-token: write"; inperm = 0 }
    /^ *credentials_json:/ { ind = substr($0, 1, index($0, "c") - 1); print ind "workload_identity_provider: " p; print ind "service_account: " sa; next }
    /^ *workload_identity_provider:/ { ind = substr($0, 1, index($0, "w") - 1); print ind "workload_identity_provider: " p; next }
    /^ *service_account:/ { ind = substr($0, 1, index($0, "s") - 1); print ind "service_account: " sa; next }
    { print }' "$f" >"$f.new"
  if cmp -s "$f" "$f.new"; then echo "  $wf already signs in with Workload Identity"
  else commit ".github/workflows/$wf" "$f.new" "Backups: $wf signs in with Workload Identity (no stored key)"; fi
}
keyless backup.yml
# The site part of rebuild drills, when the pull request carries one.
keyless "$(envv DRILL_WORKFLOW | grep . || echo rebuild-drill.yml)" optional

step "3/7 Backup bucket and roles"
kit setup || die "setup failed"
step "4/7 Point-in-time recovery, delete protection, managed backups"
kit protect || die "protect failed"
step "5/7 Off-site bucket in the vault"
kit offsite || die "offsite failed"
OFFSITE="$(envv OFFSITE_BUCKET)"; BUCKET="$(envv BACKUP_BUCKET)"; BUCKET="${BUCKET:-$PROJECT_ID-backups}"
VAULT="$(envv VAULT_PROJECT)"; DRILL="$(envv DRILL_PROJECT)"
if [ "$VAULT_ACCESS_TOKEN_FILE" != "$ACCESS_TOKEN_FILE" ] && [ -n "$OFFSITE" ] && [ -n "${ACCESS_EMAIL:-}" ]; then
  # The first backup below runs as the project owner and copies itself off-site.
  bind_bucket gv "$OFFSITE" "user:$ACCESS_EMAIL" roles/storage.objectCreator roles/storage.objectViewer
fi

step "6/7 The manager app may read, prune and drill these backups"
bind_bucket owner "$BUCKET" "serviceAccount:$RUNNER_SA" roles/storage.objectAdmin roles/storage.legacyBucketReader
[ -z "$OFFSITE" ] || bind_bucket gv "$OFFSITE" "serviceAccount:$RUNNER_SA" roles/storage.objectViewer roles/storage.legacyBucketReader
if [ -n "$VAULT" ]; then
  for r in roles/secretmanager.secretAccessor roles/browser; do
    gv projects add-iam-policy-binding "$VAULT" --member="serviceAccount:$RUNNER_SA" --role="$r" --condition=None --quiet --format=none || die "could not grant $r on $VAULT"
  done
fi
if [ -n "$DRILL" ]; then
  gv projects add-iam-policy-binding "$DRILL" --member="serviceAccount:$RUNNER_SA" --role=roles/owner --condition=None --quiet --format=none \
    || die "could not make the runner an owner of $DRILL"
fi
echo "  done"

step "7/7 First backup"
kit run || die "the first backup failed (see above); fix it and press Set it up here again"
printf '\nSET UP: %s. Merge the pull request so the nightly backup runs.\n' "$PROJECT_ID"
