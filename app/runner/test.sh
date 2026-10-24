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
exit "$fail"
