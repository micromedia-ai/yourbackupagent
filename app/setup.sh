#!/usr/bin/env bash
# One-time setup and deploys of the YourBackupAgent Manager app
# (Firebase project yourbackupagent-app). Run from a checkout of
# dagangilat/yourbackupagent on a Mac, logged in to gcloud and firebase as
# the app owner (dagan.gilat@gmail.com). Every step can be run again.
#
#   app/setup.sh create            project, Firebase, Firestore, the runner account
#   app/setup.sh token             store the GitHub token the app uses (asks for it)
#   app/setup.sh runner            build and deploy the kit runner job
#   app/setup.sh grant PROJECT_ID  let the app read and prune PROJECT_ID's backups,
#                                  read its vault copies and use the drill project
#   app/setup.sh email             turn on email alerts: the Resend API key (asks for it,
#                                  or --from PROJECT copies RESEND_API_KEY from there)
#   app/setup.sh deploy            build and deploy the web app, API and rules
#   app/setup.sh status            what exists
#
# bash 3.2 compatible. Prints every command before it runs it.
set -euo pipefail

APP_PROJECT="${APP_PROJECT:-yourbackupagent-app}"
OWNER="${OWNER:-dagan.gilat@gmail.com}"
REGION=us-central1
RUNNER=kit-runner
RUNNER_SA="$RUNNER@$APP_PROJECT.iam.gserviceaccount.com"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
IMAGE="$REGION-docker.pkg.dev/$APP_PROJECT/yourbackupagent/kit-runner"

say() { printf '%s\n' "$*"; }
info() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
run() { printf '  + %s\n' "$*" >&2; "$@"; }
retry() { # retry CMD...: a few tries 20s apart (new IAM accounts appear slowly)
  local n=1
  until "$@"; do
    [ "$n" -lt 4 ] || return 1
    say "  (not ready yet, trying again in 20s)"; n=$((n + 1)); sleep 20
  done
}
G=(gcloud --account="$OWNER")
F=(firebase --account "$OWNER")

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is missing ($2)"; }
need gcloud "brew install --cask google-cloud-sdk"
need jq "brew install jq"

env_of() { # env_of <repo checkout dir or backup.env> KEY
  sed -n "s/^$2=//p" "$1" | tr -d '"' | tail -n 1
}

cmd_create() {
  info "Project $APP_PROJECT (owner $OWNER)"
  if ! "${G[@]}" projects describe "$APP_PROJECT" >/dev/null 2>&1; then
    run "${G[@]}" projects create "$APP_PROJECT" --name="YourBackupAgent Manager"
  fi
  if [ "$("${G[@]}" billing projects describe "$APP_PROJECT" --format='value(billingEnabled)' 2>/dev/null || true)" != "True" ]; then
    local acct
    acct="$("${G[@]}" billing accounts list --filter=open=true --format='value(name)' | head -n 1 | sed 's#^billingAccounts/##')"
    [ -n "$acct" ] || die "$OWNER has no open billing account"
    run "${G[@]}" billing projects link "$APP_PROJECT" --billing-account="$acct" --format=none
  fi
  run "${G[@]}" services enable firebase.googleapis.com firestore.googleapis.com cloudfunctions.googleapis.com \
    run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
    cloudscheduler.googleapis.com eventarc.googleapis.com pubsub.googleapis.com identitytoolkit.googleapis.com \
    iam.googleapis.com cloudresourcemanager.googleapis.com --project "$APP_PROJECT"
  need firebase "npm install -g firebase-tools; firebase login:add $OWNER"
  if ! "${F[@]}" projects:list --json 2>/dev/null | jq -e --arg p "$APP_PROJECT" '.result[] | select(.projectId == $p)' >/dev/null; then
    run "${F[@]}" projects:addfirebase "$APP_PROJECT" || die "could not add Firebase. Sign the firebase CLI in as $OWNER (firebase login:add $OWNER), or add it in console.firebase.google.com -> Create a project -> existing project $APP_PROJECT, then run create again"
  fi
  if [ "$("${F[@]}" apps:list WEB --project "$APP_PROJECT" --json 2>/dev/null | jq '.result | length')" = "0" ]; then
    run "${F[@]}" apps:create WEB "YourBackupAgent Manager" --project "$APP_PROJECT"
  fi
  if ! "${G[@]}" firestore databases describe --database='(default)' --project "$APP_PROJECT" >/dev/null 2>&1; then
    run "${G[@]}" firestore databases create --location=nam5 --project "$APP_PROJECT"
  fi
  if ! "${G[@]}" iam service-accounts describe "$RUNNER_SA" --project "$APP_PROJECT" >/dev/null 2>&1; then
    run "${G[@]}" iam service-accounts create "$RUNNER" --project "$APP_PROJECT" \
      --display-name="YourBackupAgent runner (manager app + kit runner job)"
    say "  Waiting for the new account to show up in IAM (can take a minute)"
    sleep 30
  fi
  local role
  # Its own project: the database, start its job, write logs, receive the
  # Firestore events of the drill-alert trigger.
  for role in roles/datastore.user roles/run.developer roles/logging.logWriter roles/iam.serviceAccountTokenCreator roles/eventarc.eventReceiver roles/run.invoker; do
    retry run "${G[@]}" projects add-iam-policy-binding "$APP_PROJECT" --member="serviceAccount:$RUNNER_SA" --role="$role" --condition=None --quiet --format=none
  done
  # Service agents the Firestore trigger needs (new projects lack them at first).
  run "${G[@]}" beta services identity create --service=eventarc.googleapis.com --project "$APP_PROJECT" --format=none || true
  run "${G[@]}" beta services identity create --service=pubsub.googleapis.com --project "$APP_PROJECT" --format=none || true
  # Start executions of the job as itself.
  retry run "${G[@]}" iam service-accounts add-iam-policy-binding "$RUNNER_SA" --project "$APP_PROJECT" \
    --member="serviceAccount:$RUNNER_SA" --role=roles/iam.serviceAccountUser --quiet --format=none
  say ""
  say "  Next, in the Firebase console (console.firebase.google.com/project/$APP_PROJECT/authentication/providers):"
  say "  Authentication -> Get started -> Sign-in method -> Google -> Enable -> Save. Then: app/setup.sh token"
}

cmd_token() {
  info "GitHub token for the app (secret GITHUB_TOKEN in $APP_PROJECT)"
  say "  Create a fine-grained token at https://github.com/settings/personal-access-tokens/new"
  say "  Owner dagangilat, All repositories (or the ones to protect + yourbackupagent), permissions:"
  say "  Contents, Pull requests, Actions, Workflows: Read and write; Secrets, Metadata: Read-only."
  local t
  printf '  Paste it (not shown): '
  read -rs t; printf '\n'
  [ -n "$t" ] || die "no token"
  if "${G[@]}" secrets describe GITHUB_TOKEN --project "$APP_PROJECT" >/dev/null 2>&1; then
    printf '%s' "$t" | run "${G[@]}" secrets versions add GITHUB_TOKEN --data-file=- --project "$APP_PROJECT" --format=none
  else
    printf '%s' "$t" | run "${G[@]}" secrets create GITHUB_TOKEN --data-file=- --replication-policy=automatic --project "$APP_PROJECT" --format=none
  fi
  run "${G[@]}" secrets add-iam-policy-binding GITHUB_TOKEN --project "$APP_PROJECT" \
    --member="serviceAccount:$RUNNER_SA" --role=roles/secretmanager.secretAccessor --quiet --format=none
}

MAIL_DOMAIN="${MAIL_DOMAIN:-plantagoai.com}"

put_secret() { # put_secret NAME (value on stdin)
  if "${G[@]}" secrets describe "$1" --project "$APP_PROJECT" >/dev/null 2>&1; then
    run "${G[@]}" secrets versions add "$1" --data-file=- --project "$APP_PROJECT" --format=none
  else
    run "${G[@]}" secrets create "$1" --data-file=- --replication-policy=automatic --project "$APP_PROJECT" --format=none
  fi
  run "${G[@]}" secrets add-iam-policy-binding "$1" --project "$APP_PROJECT" \
    --member="serviceAccount:$RUNNER_SA" --role=roles/secretmanager.secretAccessor --quiet --format=none
}

cmd_email() {
  info "Email alerts (secret RESEND_API_KEY in $APP_PROJECT, sender backups@$MAIL_DOMAIN)"
  local k="" from=""
  if [ "${1:-}" = "--from" ]; then
    from="${2:-}"; [ -n "$from" ] || die "usage: app/setup.sh email [--from PROJECT_ID]"
    k="$(gcloud secrets versions access latest --secret=RESEND_API_KEY --project "$from")" || die "cannot read RESEND_API_KEY in $from"
  else
    say "  The Resend API key that sends for $MAIL_DOMAIN (resend.com/api-keys)."
    printf '  Paste it (not shown): '
    read -rs k; printf '\n'
  fi
  [[ "$k" =~ ^re_ ]] || die "that does not look like a Resend key (starts with re_)"
  printf '%s' "$k" | put_secret RESEND_API_KEY
  local st
  st="$(curl -s -H "Authorization: Bearer $k" https://api.resend.com/domains | jq -r --arg d "$MAIL_DOMAIN" '[.data[]? | select(.name == $d) | .status][0] // "unknown"')"
  case "$st" in
    verified) say "  $MAIL_DOMAIN is verified in Resend." ;;
    unknown) say "  Could not list Resend domains with this key (a sending-only key can't). If $MAIL_DOMAIN is verified there, it works." ;;
    *) say "  WARNING: $MAIL_DOMAIN is '$st' in Resend; emails fail until it is verified." ;;
  esac
  say "  Next: app/setup.sh deploy, then Settings -> Email alerts -> Send me a test."
}

cmd_runner() {
  info "Kit runner job $RUNNER ($IMAGE)"
  if ! "${G[@]}" artifacts repositories describe yourbackupagent --location "$REGION" --project "$APP_PROJECT" >/dev/null 2>&1; then
    run "${G[@]}" artifacts repositories create yourbackupagent --repository-format=docker --location "$REGION" --project "$APP_PROJECT"
  fi
  run "${G[@]}" builds submit "$APP_DIR/runner" --tag "$IMAGE" --project "$APP_PROJECT"
  run "${G[@]}" run jobs deploy "$RUNNER" --image "$IMAGE" --region "$REGION" --project "$APP_PROJECT" \
    --service-account "$RUNNER_SA" --set-secrets GH_TOKEN=GITHUB_TOKEN:latest \
    --task-timeout 3h --max-retries 0 --memory 2Gi --cpu 1
}

cmd_grant() {
  local p="${1:-}" env
  [[ "$p" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "usage: app/setup.sh grant PROJECT_ID"
  env="${BACKUP_ENV:-$PWD/backup-kit/backup.env}"
  [ -f "$env" ] || die "run it from the project's repository (no $env), or set BACKUP_ENV"
  [ "$(env_of "$env" PROJECT_ID)" = "$p" ] || die "$env is for $(env_of "$env" PROJECT_ID), not $p"
  local bucket offsite vault drill who
  bucket="$(env_of "$env" BACKUP_BUCKET)"; bucket="${bucket:-$p-backups}"
  offsite="$(env_of "$env" OFFSITE_BUCKET)"; vault="$(env_of "$env" VAULT_PROJECT)"; drill="$(env_of "$env" DRILL_PROJECT)"
  who="$(gcloud config get-value account 2>/dev/null)"
  info "Let the app's runner ($RUNNER_SA) work with $p's backups"
  say "  gs://$bucket: read and delete sets (as $who, a $p owner). The app never deletes below KEEP_MIN_SETS."
  run gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member="serviceAccount:$RUNNER_SA" --role=roles/storage.objectAdmin --quiet --format=none
  run gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member="serviceAccount:$RUNNER_SA" --role=roles/storage.legacyBucketReader --quiet --format=none
  if [ -n "$offsite" ]; then
    say "  gs://$offsite (vault): read only, for restores and drills (as $OWNER). Deleting there stays with you."
    run "${G[@]}" storage buckets add-iam-policy-binding "gs://$offsite" --member="serviceAccount:$RUNNER_SA" --role=roles/storage.objectViewer --quiet --format=none
    run "${G[@]}" storage buckets add-iam-policy-binding "gs://$offsite" --member="serviceAccount:$RUNNER_SA" --role=roles/storage.legacyBucketReader --quiet --format=none
  fi
  if [ -n "$vault" ]; then
    say "  $vault: read the copied chain secrets the drill site needs"
    run "${G[@]}" projects add-iam-policy-binding "$vault" --member="serviceAccount:$RUNNER_SA" --role=roles/secretmanager.secretAccessor --condition=None --quiet --format=none
    run "${G[@]}" projects add-iam-policy-binding "$vault" --member="serviceAccount:$RUNNER_SA" --role=roles/browser --condition=None --quiet --format=none
  fi
  if [ -n "$drill" ]; then
    say "  $drill: owner, so it can wipe, restore into and hand the drill project to GitHub (shared by every project)"
    run "${G[@]}" projects add-iam-policy-binding "$drill" --member="serviceAccount:$RUNNER_SA" --role=roles/owner --condition=None --quiet --format=none
  fi
  say "  Done. In the app: Settings -> Repositories must list $(env_of "$env" REPO); then Overview -> Refresh now."
}

cmd_deploy() {
  info "Deploy the manager app to $APP_PROJECT"
  need firebase "npm install -g firebase-tools; firebase login:add $OWNER"
  # Since 2026-10 new projects get no default Hosting site; create it once.
  if ! "${F[@]}" hosting:sites:get "$APP_PROJECT" --project "$APP_PROJECT" >/dev/null 2>&1; then
    run "${F[@]}" hosting:sites:create "$APP_PROJECT" --project "$APP_PROJECT"
  fi
  (cd "$APP_DIR" && run npm ci && run npm run build && cd functions && run npm ci --omit=dev)
  if ! "${G[@]}" secrets describe RESEND_API_KEY --project "$APP_PROJECT" >/dev/null 2>&1; then
    say "  Email alerts are off until app/setup.sh email (storing a placeholder key)."
    printf 'none' | put_secret RESEND_API_KEY
  fi
  printf 'RUNNER_SA=%s\nOWNER_EMAILS=%s\nMAIL_FROM="%s"\nAPP_URL=%s\n' "$RUNNER_SA" "$OWNER" "YourBackupAgent <backups@$MAIL_DOMAIN>" "https://$APP_PROJECT.web.app" >"$APP_DIR/functions/.env.$APP_PROJECT"
  (cd "$APP_DIR" && run "${F[@]}" deploy --project "$APP_PROJECT" --only hosting,firestore,functions --force) \
    || die "deploy failed. On a new project the Firestore trigger (drillAlert) can fail while Google sets up Eventarc: wait 3 minutes and run deploy again"
  say "  Open https://$APP_PROJECT.web.app and sign in as $OWNER."
}

cmd_status() {
  info "$APP_PROJECT"
  "${G[@]}" projects describe "$APP_PROJECT" --format='value(projectId,lifecycleState)' 2>/dev/null || say "  project missing (app/setup.sh create)"
  "${G[@]}" iam service-accounts describe "$RUNNER_SA" --project "$APP_PROJECT" --format='value(email)' 2>/dev/null || say "  runner account missing"
  "${G[@]}" secrets describe GITHUB_TOKEN --project "$APP_PROJECT" --format='value(name)' 2>/dev/null || say "  GITHUB_TOKEN missing (app/setup.sh token)"
  "${G[@]}" run jobs describe "$RUNNER" --region "$REGION" --project "$APP_PROJECT" --format='value(metadata.name)' 2>/dev/null || say "  runner job missing (app/setup.sh runner)"
}

case "${1:-}" in
  create) cmd_create ;;
  token) cmd_token ;;
  runner) cmd_runner ;;
  grant) shift; cmd_grant "${1:-}" ;;
  email) shift; cmd_email "$@" ;;
  deploy) cmd_deploy ;;
  status) cmd_status ;;
  *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
