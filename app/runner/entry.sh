#!/usr/bin/env bash
# Kit runner entry point (Cloud Run job). The manager app's API starts one
# execution per action with:
#   args            kit command, e.g.: rebuild --run 20261024T020000Z --yes
#   BACKUP_ENV_B64  the project's backup-kit/backup.env (from its repository)
#   KIT_REF         the kit version that project pins
#   LOG_DOC         the app's log line (log/<id>) to write the result to
#   GH_TOKEN        (secret) read the kit repository, start the drill workflow
#   ONBOARD_DOC     (only for "Set it up here") onboard/<id>: the repository,
#                   its branch and a project owner's short-lived browser
#                   sign-in (plus the vault owner's); read once, then deleted.
#                   The runner then runs the kit's app/runner/onboard.sh.
# The job's service account is the runner: it stands in for the vault owner
# (read the vault, work in the drill project); it cannot delete in the vault.
set -uo pipefail
: "${BACKUP_ENV_B64:?}" "${LOG_DOC:?}" "${GH_TOKEN:?}"
REF="${KIT_REF:-v1}"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "bad KIT_REF" >&2; exit 2; }
[[ "$LOG_DOC" =~ ^log/[A-Za-z0-9_-]+$ ]] || { echo "bad LOG_DOC" >&2; exit 2; }
ONBOARD_DOC="${ONBOARD_DOC:-}"
[ -z "$ONBOARD_DOC" ] || [[ "$ONBOARD_DOC" =~ ^onboard/[A-Za-z0-9_-]+$ ]] || { echo "bad ONBOARD_DOC" >&2; exit 2; }

md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"; }
SA="$(md instance/service-accounts/default/email)"
APP_PROJECT="$(md project/project-id)"
W="$(mktemp -d)"
mkdir -p "$W/backup-kit"
base64 -d <<<"$BACKUP_ENV_B64" >"$W/backup-kit/backup.env"
# The runner acts where the kit expects the vault owner (not when setting a
# project up: there the vault owner signed in in the browser).
[ -n "$ONBOARD_DOC" ] || printf '\nVAULT_ACCOUNT=%s\n' "$SA" >>"$W/backup-kit/backup.env"
gcloud config set account "$SA" --quiet >/dev/null 2>&1

report() {
  local status="$1" detail="$2" token body
  token="$(md instance/service-accounts/default/token | jq -r .access_token)"
  body="$(jq -n --arg s "$status" --arg d "$detail" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{fields: {status: {stringValue: $s}, detail: {stringValue: $d}, endedAt: {timestampValue: $t}}}')"
  curl -fsS -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    "https://firestore.googleapis.com/v1/projects/$APP_PROJECT/databases/(default)/documents/$LOG_DOC?updateMask.fieldPaths=status&updateMask.fieldPaths=detail&updateMask.fieldPaths=endedAt" \
    -d "$body" >/dev/null || echo "could not write the result to $LOG_DOC" >&2
}

FS="https://firestore.googleapis.com/v1/projects/$APP_PROJECT/databases/(default)/documents"
if [ -n "$ONBOARD_DOC" ]; then
  token="$(md instance/service-accounts/default/token | jq -r .access_token)"
  doc="$(curl -fsS -H "Authorization: Bearer $token" "$FS/$ONBOARD_DOC")" || { report failed "the sign-in for this setup is gone (it is used once); press Set it up here again"; exit 1; }
  curl -fsS -X DELETE -H "Authorization: Bearer $token" "$FS/$ONBOARD_DOC" >/dev/null || echo "could not delete $ONBOARD_DOC" >&2
  f() { jq -r --arg k "$1" '.fields[$k].stringValue // empty' <<<"$doc"; }
  (umask 077; f ownerToken >"$W/owner.tok"; f vaultToken >"$W/vault.tok")
  [ -s "$W/vault.tok" ] || rm -f "$W/vault.tok"
  ONBOARD_REPO="$(f repo)"; ONBOARD_BRANCH="$(f branch)"; ONBOARD_EMAIL="$(f ownerEmail)"
  unset doc
fi

auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
if ! git -c http.extraHeader="Authorization: Basic $auth" clone -q --depth 1 --branch "$REF" \
    https://github.com/dagangilat/yourbackupagent "$W/kit" 2>"$W/clone.err"; then
  report failed "could not fetch the kit at $REF"
  exit 1
fi
export GH_TOKEN

cd "$W" || exit 1
if [ -n "$ONBOARD_DOC" ]; then
  BACKUP_ENV="$W/backup-kit/backup.env" KIT="$W/kit/kit/backup.sh" KIT_REF_USED="$REF" CI=1 RUNNER_SA="$SA" \
    REPO="$ONBOARD_REPO" BRANCH="$ONBOARD_BRANCH" ACCESS_EMAIL="$ONBOARD_EMAIL" ACCESS_TOKEN_FILE="$W/owner.tok" \
    VAULT_ACCESS_TOKEN_FILE="$([ -s "$W/vault.tok" ] && echo "$W/vault.tok")" \
    bash "$W/kit/app/runner/onboard.sh" 2>&1 | tee "$W/out"
  rc="${PIPESTATUS[0]}"
else
  BACKUP_ENV="$W/backup-kit/backup.env" KIT_REF_USED="$REF" CI=1 "$W/kit/kit/backup.sh" "$@" 2>&1 | tee "$W/out"
  rc="${PIPESTATUS[0]}"
fi
# The kit prints ids, counts and step names only, never data or secrets.
detail="$(grep -v '^  + ' "$W/out" | tail -n 30)"
if [ "$rc" = "0" ]; then report succeeded "$detail"; else report failed "$detail"; fi
rm -rf "$W"
exit "$rc"
