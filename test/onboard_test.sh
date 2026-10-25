#!/usr/bin/env bash
# Offline test of onboard.sh: fake gcloud and gh, a local git "origin",
# a stub backup-kit/backup.sh and app/setup.sh. Checks the order of steps,
# the GitHub key path and that it runs again cleanly.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
LOG="$T/calls.log"; export LOG
mkdir -p "$T/bin" "$T/seed/backup-kit" "$T/seed/.github/workflows"
fail() { printf 'FAIL: %s\n' "$*"; cat "$LOG"; exit 1; }
pass=0; ok() { pass=$((pass + 1)); printf 'ok %s\n' "$*"; }

cat >"$T/bin/gcloud" <<'G'
#!/usr/bin/env bash
echo "gcloud $*" >>"$LOG"
case "$*" in
  "auth list"*) printf 'owner@x.com\ndagan.gilat@gmail.com\n' ;;
  "config get-value account"*) echo owner@x.com ;;
  "projects get-iam-policy demo-p --account owner@x.com"*) echo '{"bindings":[{"role":"roles/owner","members":["user:Owner@x.com"]}]}' ;;
  "projects get-iam-policy"*) echo '{"bindings":[]}' ;;
  *"projects describe demo-drill"*) echo "{\"labels\":${FAKE_DRILL:-null}}" ;;
  "iam service-accounts describe"*) [ -f "$LOG.sa" ] ;;
  "iam service-accounts create"*) touch "$LOG.sa" ;;
  "iam service-accounts keys create"*) echo '{"private_key":"x"}' >"$5" ;;
esac
G
cat >"$T/bin/gh" <<'H'
#!/usr/bin/env bash
echo "gh $*" >>"$LOG"
case "$*" in
  "repo clone"*) git clone -q "$ORIGIN" "$4" ;;
  "secret list"*) [ -f "$LOG.secret" ] && echo YOURBACKUPAGENT_SA_KEY; true ;;
  "secret set"*) cat >/dev/null; touch "$LOG.secret" ;;
  "pr view yourbackupagent/protect"*"--json state"*) if [ -f "$LOG.merged" ]; then echo MERGED; else echo OPEN; fi ;;
  "pr view"*"--json state"*) echo OPEN ;;
  "pr view"*) echo https://github.com/x/pull/14 ;;
  "repo view"*) echo main ;;
esac
H
cat >"$T/seed/backup-kit/backup.sh" <<'B'
#!/usr/bin/env bash
echo "kit $* as ${CLOUDSDK_CORE_ACCOUNT:-} kit ${YOURBACKUPAGENT_DIR:-}" >>"$LOG"
B
cat >"$T/setup.sh" <<'S'
#!/usr/bin/env bash
echo "app $* in $(basename "$PWD")" >>"$LOG"
S
chmod +x "$T/bin/"* "$T/seed/backup-kit/backup.sh" "$T/setup.sh"
printf 'KIT_REF=v1.1\nPROJECT_ID=demo-p\nOFFSITE_BUCKET=yba-demo\nDRILL_PROJECT=demo-drill\nDRILL_WORKFLOW=rebuild-drill.yml\nCI_SA=\nVAULT_ACCOUNT=dagan.gilat@gmail.com\n' >"$T/seed/backup-kit/backup.env"
printf 'with:\n  credentials_json: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}\n' >"$T/seed/.github/workflows/backup.yml"
printf 'with:\n  credentials_json: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}\nenv:\n  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n' >"$T/seed/.github/workflows/rebuild-drill.yml"
git init -q --bare "$T/origin.git"
(cd "$T/seed" && git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -q -m seed \
  && git push -q "$T/origin.git" main && git checkout -q -b yourbackupagent/protect && git push -q "$T/origin.git" yourbackupagent/protect)
export ORIGIN="$T/origin.git" PATH="$T/bin:$PATH" YBA_WORK="$T/work" YBA_APP_SETUP="$T/setup.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

"$ROOT/onboard.sh" dagangilat/demo --no-drill </dev/null >"$T/out1" 2>&1 || { cat "$T/out1"; fail "first run exited non-zero"; }
order="$(grep -E '^(kit|app) ' "$LOG" | cut -d' ' -f1-2 | tr '\n' ' ')"
[ "$order" = "kit setup kit protect kit offsite kit run app grant " ] || fail "step order: $order"; ok "steps in order"
grep -q '^kit setup as owner@x.com' "$LOG" || fail "kit not run as the project owner"; ok "kit runs as the project owner"
grep -q '^app grant demo-p in demo' "$LOG" || fail "grant not run from the repo"; ok "grant from the repository"
grep -q '^kit setup as owner@x.com' "$LOG" && grep -q "^kit setup .*kit $ROOT" "$LOG" || fail "kit not run from this checkout"; ok "kit runs from this checkout"
grep -q '^gcloud storage buckets add-iam-policy-binding gs://yba-demo --member user:owner@x.com --role roles/storage.objectCreator --account dagan.gilat@gmail.com' "$LOG" || fail "owner cannot add to the vault bucket"
grep -q '^gcloud storage buckets add-iam-policy-binding gs://yba-demo --member user:owner@x.com --role roles/storage.objectViewer --account dagan.gilat@gmail.com' "$LOG" || fail "owner cannot read the vault bucket"
ok "project owner may copy into the vault bucket"
grep -q '^gcloud iam service-accounts create yourbackupagent-ci --project demo-p' "$LOG" || fail "no service account"; ok "service account made"
grep -q '^gh secret set YOURBACKUPAGENT_SA_KEY --repo dagangilat/demo' "$LOG" || fail "no secret"; ok "key stored as a secret"
git --git-dir="$T/origin.git" show yourbackupagent/protect:backup-kit/backup.env | grep -qx 'CI_SA=yourbackupagent-ci@demo-p.iam.gserviceaccount.com' || fail "CI_SA not pushed"; ok "CI_SA committed and pushed"
git --git-dir="$T/origin.git" show yourbackupagent/protect:.github/workflows/backup.yml | grep -q 'secrets.YOURBACKUPAGENT_SA_KEY' || fail "secret name not pushed"; ok "workflow secret name pushed"
git --git-dir="$T/origin.git" show yourbackupagent/protect:.github/workflows/rebuild-drill.yml | grep -q 'credentials_json: ${{ secrets.YOURBACKUPAGENT_SA_KEY }}' || fail "drill workflow key not switched"
git --git-dir="$T/origin.git" show yourbackupagent/protect:.github/workflows/rebuild-drill.yml | grep -q 'secrets.NPM_TOKEN' || fail "drill workflow's other secrets changed"
ok "drill workflow signs in with the same key, other secrets untouched"
grep -qi 'private_key' "$T/out1" && fail "key printed"; ok "key never printed"
grep -q 'gh pr merge' "$LOG" && fail "merged without asking"; ok "no merge without a yes"

: >"$LOG"
"$ROOT/onboard.sh" dagangilat/demo --no-drill </dev/null >"$T/out2" 2>&1 || { cat "$T/out2"; fail "second run exited non-zero"; }
grep -q 'keys create' "$LOG" && fail "second run made another key"; ok "second run reuses the key"
grep -q '^kit run' "$LOG" || fail "second run skipped the backup"; ok "second run backs up again"

# The protect pull request was merged before onboard ran (and its branch kept):
# a new key must go to a fresh pull request, never the dead branch.
: >"$LOG"; rm -f "$LOG.sa" "$LOG.secret"; touch "$LOG.merged"
rm -rf "$T/work"
before="$(git --git-dir="$T/origin.git" rev-parse yourbackupagent/protect)"
"$ROOT/onboard.sh" dagangilat/demo --no-drill </dev/null >"$T/out3" 2>&1 || { cat "$T/out3"; fail "merged-PR run exited non-zero"; }
[ "$(git --git-dir="$T/origin.git" rev-parse yourbackupagent/protect)" = "$before" ] || fail "pushed to the merged branch"; ok "merged PR: protect branch untouched"
git --git-dir="$T/origin.git" show yourbackupagent/ci-key:backup-kit/backup.env | grep -qx 'CI_SA=yourbackupagent-ci@demo-p.iam.gserviceaccount.com' || fail "no ci-key branch"; ok "merged PR: key settings on a new branch"
grep -q '^gh pr create --repo dagangilat/demo --head yourbackupagent/ci-key' "$LOG" || fail "no new PR"; ok "merged PR: a new pull request"

# Run again while that key pull request is open: work on its branch, reuse
# the key, and open no second pull request.
: >"$LOG"
"$ROOT/onboard.sh" dagangilat/demo --no-drill </dev/null >"$T/out4" 2>&1 || { cat "$T/out4"; fail "key-PR rerun exited non-zero"; }
grep -q 'keys create' "$LOG" && fail "key-PR rerun made another key"; ok "open key PR: key reused"
grep -q 'gh pr create' "$LOG" && fail "key-PR rerun opened another PR"; ok "open key PR: no second pull request"
grep -q '^kit run' "$LOG" || fail "key-PR rerun skipped the backup"; ok "open key PR: backs up"

# The drill project holds another project's finished drill: replace it (after
# asking; the default is yes). A drill still running there: skip, no rebuild.
: >"$LOG"
FAKE_DRILL='{"drill-of":"other-app","drill-data":"passed"}' "$ROOT/onboard.sh" dagangilat/demo --drill </dev/null >"$T/out5" 2>&1 || { cat "$T/out5"; fail "drill run exited non-zero"; }
grep -q '^kit rebuild --replace' "$LOG" || fail "finished drill of another project not replaced"; ok "drill: replaces another project's finished drill"
: >"$LOG"
FAKE_DRILL="{\"drill-of\":\"other-app\",\"drill-data\":\"running\",\"drill-since\":\"$(date +%s)\"}" "$ROOT/onboard.sh" dagangilat/demo --drill </dev/null >"$T/out6" 2>&1 || { cat "$T/out6"; fail "busy drill run exited non-zero"; }
grep -q '^kit rebuild' "$LOG" && fail "rebuilt over a running drill"; grep -q 'drill project busy' "$T/out6" || fail "busy not reported"; ok "drill: a running drill is left alone"
: >"$LOG"
"$ROOT/onboard.sh" dagangilat/demo --drill </dev/null >"$T/out7" 2>&1 || { cat "$T/out7"; fail "free drill run exited non-zero"; }
grep -q '^kit rebuild as ' "$LOG" || fail "free drill project not used"; ok "drill: free drill project, no --replace"

"$ROOT/onboard.sh" not-a-repo >/dev/null 2>&1 && fail "bad repo accepted"; ok "bad repo refused"
echo "onboard: $pass passed"
