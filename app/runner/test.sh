#!/usr/bin/env bash
# Offline test of entry.sh: fake metadata server, Firestore, gcloud and git.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KITREPO="$(cd "$HERE/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat >"$T/bin/curl" <<'S'
#!/usr/bin/env bash
url="${*: -1}"
for a in "$@"; do case "$a" in https://firestore*) url="$a" ;; esac; done
case "$url" in
  *service-accounts/default/email) echo runner@app.iam.gserviceaccount.com ;;
  *project/project-id) echo app-proj ;;
  *service-accounts/default/token) echo '{"access_token":"tok"}' ;;
  https://firestore*/documents/onboard/*)
    case " $* " in
      *" -X DELETE "*) printf '%s\n' "$url" >>"$FAKE_T/deleted" ;;
      *) [ -f "$FAKE_T/deleted" ] && exit 22
         echo '{"fields":{"ownerToken":{"stringValue":"ya29.owner"},"vaultToken":{"stringValue":"ya29.vault"},"repo":{"stringValue":"me/site"},"branch":{"stringValue":"yourbackupagent/protect"},"ownerEmail":{"stringValue":"owner@example.com"}}}' ;;
    esac ;;
  https://firestore*) printf '%s\n' "$url" >"$FAKE_T/patch.url"; while [ $# -gt 0 ]; do [ "$1" = "-d" ] && printf '%s' "$2" >"$FAKE_T/patch.json"; shift; done ;;
  *) exit 7 ;;
esac
S
printf '#!/bin/sh\nexit 0\n' >"$T/bin/gcloud"
cat >"$T/bin/git" <<'S'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_T/git.log"
dst="${*: -1}"; cp -r "$FAKE_KIT" "$dst"
S
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" FAKE_T="$T" FAKE_KIT="$KITREPO" GH_TOKEN=ghs_secret LOG_DOC=log/abc KIT_REF=v1.1
BACKUP_ENV_B64="$(printf 'PROJECT_ID=demo-app\nBACKUP_BUCKET=demo-app-backups\n' | base64 -w0)"
export BACKUP_ENV_B64
fail=0
"$HERE/entry.sh" --help >"$T/out" 2>&1
[ "$(jq -r .fields.status.stringValue "$T/patch.json")" = succeeded ] && grep -q 'This help' <<<"$(jq -r .fields.detail.stringValue "$T/patch.json")" \
  && echo "ok   a passing kit command is logged as succeeded with its output" || { echo "FAIL succeeded"; cat "$T/out"; fail=1; }
grep -q 'documents/log/abc?updateMask' "$T/patch.url" && echo "ok   the result goes to the given log line" || { echo "FAIL url"; fail=1; }
! grep -q ghs_secret "$T/git.log" && grep -q 'branch v1.1' "$T/git.log" && echo "ok   the kit is cloned at KIT_REF, token not in the command line" || { echo "FAIL git"; cat "$T/git.log"; fail=1; }
"$HERE/entry.sh" nonsense >"$T/out" 2>&1; rc=$?
[ "$rc" != 0 ] && [ "$(jq -r .fields.status.stringValue "$T/patch.json")" = failed ] && echo "ok   a failing kit command is logged as failed" || { echo "FAIL failed"; fail=1; }
LOG_DOC='log/../config/access' "$HERE/entry.sh" --help >"$T/out" 2>&1; rc=$?
[ "$rc" = 2 ] && echo "ok   a log path outside log/ is refused" || { echo "FAIL logdoc"; fail=1; }

# "Set it up here": the sign-in is read once, deleted, and handed to onboard.sh as files.
K2="$T/kit2"; cp -r "$KITREPO" "$K2"
cat >"$K2/app/runner/onboard.sh" <<'S'
#!/usr/bin/env bash
{ echo "repo=$REPO branch=$BRANCH email=$ACCESS_EMAIL runner=$RUNNER_SA"
  echo "owner=$(cat "$ACCESS_TOKEN_FILE") vault=$(cat "$VAULT_ACCESS_TOKEN_FILE") mode=$(stat -c %a "$ACCESS_TOKEN_FILE")"
  grep -c '^VAULT_ACCOUNT=' "$BACKUP_ENV" || true; } >"$FAKE_T/onboard.seen"
echo "SET UP"
S
FAKE_KIT="$K2" ONBOARD_DOC=onboard/xyz "$HERE/entry.sh" >"$T/out" 2>&1; rc=$?
[ "$rc" = 0 ] && grep -q "repo=me/site branch=yourbackupagent/protect email=owner@example.com runner=runner@app.iam.gserviceaccount.com" "$T/onboard.seen" \
  && grep -q "owner=ya29.owner vault=ya29.vault mode=600" "$T/onboard.seen" && [ "$(tail -n 1 "$T/onboard.seen")" = 0 ] \
  && echo "ok   onboarding hands the owner and vault sign-ins to onboard.sh as private files (vault account kept)" || { echo "FAIL onboard"; cat "$T/out" "$T/onboard.seen"; fail=1; }
grep -q 'documents/onboard/xyz' "$T/deleted" && echo "ok   the sign-in document is deleted after reading" || { echo "FAIL delete"; fail=1; }
! grep -q 'ya29' "$T/out" && ! grep -q 'ya29' <<<"$(jq -r .fields.detail.stringValue "$T/patch.json")" && echo "ok   no token in the output or the log" || { echo "FAIL leak"; fail=1; }
FAKE_KIT="$K2" ONBOARD_DOC=onboard/xyz "$HERE/entry.sh" >"$T/out" 2>&1; rc=$?
[ "$rc" != 0 ] && grep -q 'used once' <<<"$(jq -r .fields.detail.stringValue "$T/patch.json")" && echo "ok   a used sign-in cannot be used again" || { echo "FAIL reuse"; cat "$T/out"; fail=1; }
ONBOARD_DOC='onboard/../log/x' "$HERE/entry.sh" >"$T/out" 2>&1; rc=$?
[ "$rc" = 2 ] && echo "ok   an onboarding path outside onboard/ is refused" || { echo "FAIL onboarddoc"; fail=1; }
exit "$fail"
