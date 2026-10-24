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
  "pr view"*"--json state"*) if [ -f "$LOG.merged" ]; then echo MERGED; else echo OPEN; fi ;;
  "pr view"*) echo https://github.com/x/pull/14 ;;
  "repo view"*) echo main ;;
esac
H
cat >"$T/seed/backup-kit/backup.sh" <<'B'
#!/usr/bin/env bash
echo "kit $* as ${CLOUDSDK_CORE_ACCOUNT:-}" >>"$LOG"
B
cat >"$T/setup.sh" <<'S'
#!/usr/bin/env bash
echo "app $* in $(basename "$PWD")" >>"$LOG"
S
chmod +x "$T/bin/"* "$T/seed/backup-kit/backup.sh" "$T/setup.sh"
printf 'KIT_REF=v1.1\nPROJECT_ID=demo-p\nCI_SA=\nVAULT_ACCOUNT=dagan.gilat@gmail.com\n' >"$T/seed/backup-kit/backup.env"
printf 'with:\n  credentials_json: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}\n' >"$T/seed/.github/workflows/backup.yml"
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
grep -q '^gcloud iam service-accounts create yourbackupagent-ci --project demo-p' "$LOG" || fail "no service account"; ok "service account made"
grep -q '^gh secret set YOURBACKUPAGENT_SA_KEY --repo dagangilat/demo' "$LOG" || fail "no secret"; ok "key stored as a secret"
git --git-dir="$T/origin.git" show yourbackupagent/protect:backup-kit/backup.env | grep -qx 'CI_SA=yourbackupagent-ci@demo-p.iam.gserviceaccount.com' || fail "CI_SA not pushed"; ok "CI_SA committed and pushed"
git --git-dir="$T/origin.git" show yourbackupagent/protect:.github/workflows/backup.yml | grep -q 'secrets.YOURBACKUPAGENT_SA_KEY' || fail "secret name not pushed"; ok "workflow secret name pushed"
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

"$ROOT/onboard.sh" not-a-repo >/dev/null 2>&1 && fail "bad repo accepted"; ok "bad repo refused"
echo "onboard: $pass passed"
