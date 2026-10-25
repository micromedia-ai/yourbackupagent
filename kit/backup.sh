#!/usr/bin/env bash
# Backup kit: back up, restore, drill and archive a Firebase project.
#
# One script for every project (github.com/dagangilat/yourbackupagent); the
# project's own settings are in its backup-kit/backup.env. Runs on a Mac or Linux terminal with the
# Google Cloud CLI, jq and curl (Cloud Shell has all three), and in GitHub
# Actions. bash 3.2 compatible. See backup-kit/README.md.
#
# Usage: backup-kit/backup.sh <command> [options]   (backup-kit/backup.sh --help)
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_VERSION=1.1
# shellcheck source=lib.sh
. "$KIT_DIR/lib.sh"

# The project's settings: BACKUP_ENV, else backup-kit/backup.env under the
# current directory (run from the project's repository).
ENV_FILE="${BACKUP_ENV:-$PWD/backup-kit/backup.env}"
[ -f "$ENV_FILE" ] || die "no settings file $ENV_FILE (run from the project's repository, or set BACKUP_ENV; template: templates/backup.env.example in dagangilat/yourbackupagent)"
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
# The project's git repository (commit in the manifest, code bundle in archives).
REPO_DIR="$(git -C "$(dirname "$ENV_FILE")" rev-parse --show-toplevel 2>/dev/null || dirname "$ENV_FILE")"
KIT_REF="${KIT_REF_USED:-$(git -C "$KIT_DIR" describe --tags --always 2>/dev/null || echo unknown)}"
# shellcheck disable=SC1090
. "$ENV_FILE"

PROJECT_ID="${PROJECT_ID:-}"
PROJECT_LABEL="${PROJECT_LABEL:-$PROJECT_ID}"
REPO="${REPO:-}"
CI_SA="${CI_SA:-}"
BACKUP_BUCKET="${BACKUP_BUCKET:-$PROJECT_ID-backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_MIN_SETS="${KEEP_MIN_SETS:-7}"
FIRESTORE_DATABASES="${FIRESTORE_DATABASES:-auto}"
STORAGE_BUCKETS="${STORAGE_BUCKETS:-auto}"
RTDB="${RTDB:-auto}"
REGIONS="${REGIONS:-us-central1}"
MANAGED_KEEP_DAYS="${MANAGED_KEEP_DAYS:-14}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
VAULT_ACCOUNT="${VAULT_ACCOUNT:-}"
VAULT_PROJECT="${VAULT_PROJECT:-}"
OFFSITE_BUCKET="${OFFSITE_BUCKET:-}"
OFFSITE_KEEP_DAYS="${OFFSITE_KEEP_DAYS:-90}"
ARCHIVE_BUCKET="${ARCHIVE_BUCKET:-}"
DRILL_PROJECT="${DRILL_PROJECT:-}"
CHAIN_SECRETS="${CHAIN_SECRETS:-}"
DRILL_KMS_KEYS="${DRILL_KMS_KEYS:-}"
DRILL_WORKFLOW="${DRILL_WORKFLOW:-rebuild-drill.yml}"
RUN_TIMEOUT_MIN="${RUN_TIMEOUT_MIN:-60}"
RETRIES="${RETRIES:-4}"

usage() {
  cat <<EOF
Usage: backup-kit/backup.sh <command> [options]      ($PROJECT_LABEL: $PROJECT_ID)

Every day (GitHub Actions runs these; you can too)
  run               Back up now: Firestore (consistent point in time), Storage,
                    Auth users with password hashes, Realtime Database, project
                    config. Writes gs://$BACKUP_BUCKET/runs/<id>/ and copies the run
                    to the off-site bucket gs://$OFFSITE_BUCKET.
  check             Fail when the newest good backup is older than ${MAX_AGE_HOURS}h or a
                    step failed; warn about missing protection (read-only)
  status            Recent runs, counts, buckets, protection (read-only)
  prune [--vault]   Delete old backup sets: the newest $KEEP_MIN_SETS good sets are always
                    kept, other good sets once older than $BACKUP_KEEP_DAYS days ($OFFSITE_KEEP_DAYS in the
                    vault), failed or incomplete ones after 3 days. run does this
                    after every good backup; --vault (as $VAULT_ACCOUNT) prunes the off-site copies.
  delete --run ID [--vault]
                    Delete one backup set; refused for a good set when only
                    $KEEP_MIN_SETS good sets are left

Once per project (as a project owner)
  setup             Create gs://$BACKUP_BUCKET and give the
                    GitHub deploy service account the roles the daily backup needs
  protect           Firestore point-in-time recovery + delete protection, a daily
                    Google-managed Firestore backup (kept $MANAGED_KEEP_DAYS days), 30-day
                    soft delete on the backup bucket, a deletion lien on the project
  offsite           As $VAULT_ACCOUNT: vault project $VAULT_PROJECT and bucket
                    gs://$OFFSITE_BUCKET (keeps $OFFSITE_KEEP_DAYS days). GitHub may add
                    and read files there, never overwrite or delete them.
  vault-secrets     Copy the chain secrets ($CHAIN_SECRETS)
                    from Secret Manager into the vault's Secret Manager, so they
                    survive losing $PROJECT_ID. Values are never printed or saved to disk.

Proving it
  drill --here      Restore the newest backup into a temporary database drill-<time>
                    in $PROJECT_ID, compare every count with the backup, delete it.
                    Production data is never touched.
  rebuild [--from offsite|archive] [--run ID] [--data-only]
                    Full rebuild drill as $VAULT_ACCOUNT, as if $PROJECT_ID were gone:
                    wipe $DRILL_PROJECT, restore the backup from the vault into it
                    (Firestore, Storage, Auth, RTDB), check the counts, copy the chain
                    secrets, then start the "$DRILL_WORKFLOW" workflow in $REPO, which
                    deploys the site there and smoke-tests https://$DRILL_PROJECT.web.app.
  cleanup --here    Delete drill-* databases left in $PROJECT_ID
  cleanup --drill   Wipe $DRILL_PROJECT and take GitHub's access to it away

Archiving an old project
  archive           One full backup kept forever in gs://$ARCHIVE_BUCKET/archive/$PROJECT_ID/,
                    with a copy of the git repository. Then prove it:
                    rebuild --from archive. Then retire.
  retire            After a passed archive drill: remove the deletion lien and delete
                    $PROJECT_ID (Google keeps it restorable for 30 days). Asks you to type
                    the project id.

Disaster recovery
  restore --to PROJECT [--from offsite|archive|gs://BUCKET/PATH] [--run ID]
                    Restore a backup into an existing project (see the runbook)

Options
  --yes, -y         Do not ask (steps that cannot be undone still ask you to type)
  --dry-run, -n     Print what would change, change nothing
  --run ID          A backup id (default: the newest good one)
  --replace         rebuild: replace another project's drill in the drill project
  --vault           prune, delete: the off-site copies in gs://$OFFSITE_BUCKET
  --retries N       Attempts for each network call (default $RETRIES)
  --help, -h        This help

Settings: $ENV_FILE
EOF
}

# ---- arguments --------------------------------------------------------------
CMD=""
RUN_ID=""
HERE=0
DRILL=0
FROM=""
TO_PROJECT=""
DATA_ONLY=0
REPLACE=0
VAULT=0
TRIGGER="${BACKUP_TRIGGER:-manual}"
# shellcheck disable=SC2034 # ASSUME_YES and DRY_RUN are read by lib.sh
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help|help) usage; exit 0 ;;
    --here) HERE=1 ;;
    --drill) DRILL=1 ;;
    --data-only) DATA_ONLY=1 ;;
    --replace) REPLACE=1 ;;
    --vault) VAULT=1 ;;
    --run) shift; RUN_ID="${1:-}"; [ -n "$RUN_ID" ] || die "--run needs a backup id" ;;
    --from) shift; FROM="${1:-}"; [ -n "$FROM" ] || die "--from needs offsite, archive or gs://BUCKET/PATH" ;;
    --to) shift; TO_PROJECT="${1:-}" ;;
    --retries) shift; RETRIES="${1:-}"; [[ "$RETRIES" =~ ^[1-9][0-9]?$ ]] || die "--retries needs a number from 1 to 99" ;;
    status|setup|protect|offsite|vault-secrets|run|check|drill|rebuild|cleanup|restore|archive|retire|prune|delete)
      [ -z "$CMD" ] || die "one command at a time (got $CMD and $1)"
      CMD="$1" ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$CMD" ] || { usage; exit 1; }

# ---- input checks -----------------------------------------------------------
valid_project "$PROJECT_ID" || die "PROJECT_ID=$PROJECT_ID in $ENV_FILE is not a project id"
valid_bucket "$BACKUP_BUCKET" || die "BACKUP_BUCKET=$BACKUP_BUCKET is not a bucket name"
for v in BACKUP_KEEP_DAYS OFFSITE_KEEP_DAYS MAX_AGE_HOURS RUN_TIMEOUT_MIN; do
  eval "x=\${$v}"
  # shellcheck disable=SC2154
  [[ "$x" =~ ^[1-9][0-9]{0,3}$ ]] || die "$v must be a whole number (got '$x')"
done
[[ "$KEEP_MIN_SETS" =~ ^[1-9][0-9]{0,2}$ ]] || die "KEEP_MIN_SETS must be a whole number from 1 to 999 (got '$KEEP_MIN_SETS')"
[ "$VAULT" = "0" ] || case "$CMD" in prune|delete) ;; *) die "--vault only goes with prune or delete" ;; esac
[ "$VAULT" = "0" ] || [ -n "$OFFSITE_BUCKET" ] || die "--vault needs OFFSITE_BUCKET in $ENV_FILE"
[ "$CMD" != "delete" ] || [ -n "$RUN_ID" ] || die "delete needs --run ID (see: backup.sh status)"
[[ "$MANAGED_KEEP_DAYS" =~ ^[1-9][0-9]?$ ]] && [ "$MANAGED_KEEP_DAYS" -le 98 ] || die "MANAGED_KEEP_DAYS must be 1-98"
[ -z "$OFFSITE_BUCKET" ] || valid_bucket "$OFFSITE_BUCKET" || die "OFFSITE_BUCKET=$OFFSITE_BUCKET is not a bucket name"
[ -z "$ARCHIVE_BUCKET" ] || valid_bucket "$ARCHIVE_BUCKET" || die "ARCHIVE_BUCKET=$ARCHIVE_BUCKET is not a bucket name"
[ -z "$VAULT_PROJECT" ] || valid_project "$VAULT_PROJECT" || die "VAULT_PROJECT=$VAULT_PROJECT is not a project id"
[ -z "$DRILL_PROJECT" ] || valid_project "$DRILL_PROJECT" || die "DRILL_PROJECT=$DRILL_PROJECT is not a project id"
[ -z "$VAULT_ACCOUNT" ] || valid_email "$VAULT_ACCOUNT" || die "VAULT_ACCOUNT=$VAULT_ACCOUNT is not an email"
[ -z "$CI_SA" ] || [[ "$CI_SA" =~ ^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$ ]] || die "CI_SA=$CI_SA is not a service account email"
[ -z "$RUN_ID" ] || valid_run_id "$RUN_ID" || die "--run $RUN_ID is not a backup id (like 20261024T020000Z; see: backup.sh status)"
[ -z "$TO_PROJECT" ] || valid_project "$TO_PROJECT" || die "--to $TO_PROJECT is not a project id"
[ "$CMD" = "restore" ] || [ -z "$TO_PROJECT" ] || die "--to only goes with restore"
[ "$CMD" != "restore" ] || [ -n "$TO_PROJECT" ] || die "restore needs --to PROJECT"
[ "$HERE" = "0" ] || case "$CMD" in drill|cleanup) ;; *) die "--here only goes with drill or cleanup" ;; esac
[ "$DRILL" = "0" ] || [ "$CMD" = "cleanup" ] || die "--drill only goes with cleanup"
[ "$CMD" != "drill" ] || [ "$HERE" = "1" ] || die "drill needs --here (the full drill in another project is: backup.sh rebuild)"
[ "$CMD" != "cleanup" ] || [ "$HERE$DRILL" != "00" ] || die "cleanup needs --here or --drill"
[ -z "$FROM" ] || case "$CMD" in rebuild|restore) ;; *) die "--from only goes with rebuild or restore" ;; esac
case "$FROM" in ""|offsite|archive|gs://*) ;; *) die "--from must be offsite, archive or gs://BUCKET/PATH" ;; esac
for p in "$VAULT_PROJECT" "$DRILL_PROJECT"; do
  [ -z "$p" ] || [ "$p" != "$PROJECT_ID" ] || die "the vault and drill projects must not be $PROJECT_ID"
done
case "$DRILL_PROJECT" in ""|*drill*) ;; *) die "DRILL_PROJECT must contain 'drill' so it is never mistaken for a real project" ;; esac
[ -z "$DRILL_PROJECT" ] || [ "$DRILL_PROJECT" != "$VAULT_PROJECT" ] || warn "the drill project is also the vault: a drill gives GitHub owner access to it"

# Commands that run as the vault owner (the way a rebuild goes when the
# production project and its owner's account are both gone).
AS_VAULT=0
case "$CMD" in rebuild) AS_VAULT=1 ;; cleanup) [ "$DRILL" = "1" ] && AS_VAULT=1 ;; prune|delete) [ "$VAULT" = "1" ] && AS_VAULT=1 ;; esac
if [ "$AS_VAULT" = "1" ] || [ "$CMD" = "offsite" ] || [ "$CMD" = "vault-secrets" ] || [ "$CMD" = "archive" ] || [ "$CMD" = "retire" ]; then
  [ -n "$VAULT_ACCOUNT" ] && [ -n "$VAULT_PROJECT" ] || die "$CMD needs VAULT_ACCOUNT and VAULT_PROJECT in $ENV_FILE"
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/backup-kit.XXXXXX")" || die "cannot create a temp folder"
chmod 700 "$WORKDIR"
# Auth exports (password hashes) pass through WORKDIR; always remove it.
trap 'rm -rf "$WORKDIR"' EXIT

# ---- Google API helpers -----------------------------------------------------
# Every gcloud/API call goes through one of two identities: the logged-in
# account (production owner, or the CI service account), or the vault owner.
GV=(gcloud)
TOKEN=""
VTOKEN=""
token() {
  if [ -z "$TOKEN" ]; then TOKEN="$(gcloud auth print-access-token 2>/dev/null)" || die "gcloud is not logged in. Run: gcloud auth login"; fi
  printf '%s' "$TOKEN"
}
vtoken() {
  if [ -z "$VTOKEN" ]; then
    VTOKEN="$(gcloud auth print-access-token "$VAULT_ACCOUNT" 2>/dev/null)" \
      || die "$VAULT_ACCOUNT is not logged in to gcloud. Run: gcloud auth login $VAULT_ACCOUNT  (then switch back: gcloud config set account <you>)"
  fi
  printf '%s' "$VTOKEN"
}

# api_as <main|vault> <METHOD> <URL> [JSON] [QUOTA_PROJECT]: prints the body,
# fails on HTTP >= 400 (message on stderr). Network errors, 429 and 5xx are
# retried; a 401 refreshes the token once.
api_as() {
  local who="$1" method="$2" url="$3" data="${4:-}" qp="${5:-$PROJECT_ID}" out code body n=1 wait=2 refreshed=0 tok
  while :; do
    if [ "$who" = "vault" ]; then tok="$(vtoken)"; else tok="$(token)"; fi
    local args=(-sS -g -X "$method" -H "Authorization: Bearer $tok" -w '\n%{http_code}' --max-time 300)
    [ -z "$qp" ] || args+=(-H "x-goog-user-project: $qp")
    if [ -n "$data" ]; then args+=(-H 'Content-Type: application/json' --data "$data"); fi
    if out="$(curl "${args[@]}" "$url" 2>"$WORKDIR/curl.err")"; then
      code="${out##*$'\n'}"; body="${out%$'\n'*}"
    else
      code="000"; body="$(cat "$WORKDIR/curl.err")"
    fi
    if [ "$code" = "401" ] && [ "$refreshed" = "0" ]; then
      if [ "$who" = "vault" ]; then VTOKEN=""; else TOKEN=""; fi
      refreshed=1; continue
    fi
    case "$code" in
      000|429|5??)
        if [ "$n" -lt "$RETRIES" ]; then
          warn "$method ${url%%\?*} -> ${code/000/network error}, retrying in ${wait}s"
          sleep "$wait"; n=$((n + 1)); wait=$((wait * 2)); continue
        fi ;;
    esac
    break
  done
  if [ "$code" = "000" ] || [ "$code" -ge 400 ]; then
    printf '%s %s -> HTTP %s: %s\n' "$method" "${url%%\?*}" "$code" "$(printf '%s' "$body" | jq -r '.error.message // .error // .' 2>/dev/null | head -c 300)" >&2
    return 1
  fi
  printf '%s' "$body"
}
api()  { api_as main "$@"; }
vapi() { api_as vault "$@"; }
# A change: printed, and skipped in --dry-run.
change() { printf '  + %s %s\n' "$2" "${3%%\?*}" >&2; if [ "$DRY_RUN" = "1" ]; then printf '{}'; return 0; fi; api_as "$@"; }

fs_db()   { printf 'https://firestore.googleapis.com/v1/projects/%s/databases/%s' "$1" "$2"; }
fs_docs() { printf '%s/documents' "$(fs_db "$1" "$2")"; }

# wait_op <main|vault> <operation url> <what>: poll a long-running operation.
wait_op() {
  local who="$1" url="$2" what="$3" deadline res
  deadline=$(( $(date +%s) + RUN_TIMEOUT_MIN * 60 ))
  while :; do
    res="$(api_as "$who" GET "$url" "" "${4:-$PROJECT_ID}")" || return 1
    if [ "$(printf '%s' "$res" | jq -r '.done // false')" = "true" ]; then
      if printf '%s' "$res" | jq -e '.error' >/dev/null; then
        printf '%s failed: %s\n' "$what" "$(printf '%s' "$res" | jq -r '.error.message')" >&2
        return 1
      fi
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || { printf '%s did not finish in %s min\n' "$what" "$RUN_TIMEOUT_MIN" >&2; return 1; }
    sleep 10
  done
}

bucket_exists_as() { local g=("${@:2}"); "${g[@]}" storage buckets describe "gs://$1" --format='value(name)' >/dev/null 2>&1; }
object_count_as() { local g=("${@:2}"); "${g[@]}" storage objects list "$1/**" --format='value(name)' 2>/dev/null | wc -l | tr -d ' '; }
bytes_as() { local g=("${@:2}"); "${g[@]}" storage du -s "$1" 2>/dev/null | awk '{print $1+0; exit}'; }

# ---- what the project has ---------------------------------------------------
firestore_databases() {
  if [ "$FIRESTORE_DATABASES" != "auto" ]; then printf '%s\n' $FIRESTORE_DATABASES; return 0; fi
  api GET "https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases" \
    | jq -r '.databases[]? | .name | split("/") | last | select(startswith("drill-") | not)'
}
storage_buckets() {
  if [ "$STORAGE_BUCKETS" != "auto" ]; then printf '%s\n' $STORAGE_BUCKETS; return 0; fi
  # Firebase-linked buckets; fall back to the default names that exist.
  local b
  if b="$(api GET "https://firebasestorage.googleapis.com/v1beta/projects/$PROJECT_ID/buckets" 2>/dev/null | jq -r '.buckets[]?.name | split("/") | last')" && [ -n "$b" ]; then
    printf '%s\n' "$b"; return 0
  fi
  for b in "$PROJECT_ID.firebasestorage.app" "$PROJECT_ID.appspot.com"; do
    bucket_exists_as "$b" gcloud && printf '%s\n' "$b"
  done
  return 0
}
# Realtime Database instances as "id url" lines (none when the API is off).
rtdb_instances() {
  [ "$RTDB" != "none" ] || return 0
  api GET "https://firebasedatabase.googleapis.com/v1beta/projects/$PROJECT_ID/locations/-/instances" 2>/dev/null \
    | jq -r '.instances[]? | select(.state == "ACTIVE") | "\(.name | split("/") | last) \(.databaseUrl)"' || true
}

# collection_counts <project> <database> [readTime] [main|vault]: "collection count" lines.
collection_counts() {
  local p="$1" db="$2" rt="${3:-}" who="${4:-main}" base ids c n page="" body rtj=""
  base="$(fs_docs "$p" "$db")"
  [ -z "$rt" ] || rtj=",\"readTime\":\"$rt\""
  ids=""
  while :; do
    body="$(api_as "$who" POST "$base:listCollectionIds" "{\"pageSize\":300${page:+,\"pageToken\":\"$page\"}$rtj}" "$p")" || return 1
    ids="$ids $(printf '%s' "$body" | jq -r '.collectionIds[]?' | tr '\n' ' ')"
    page="$(printf '%s' "$body" | jq -r '.nextPageToken // empty')"
    [ -n "$page" ] || break
  done
  for c in $ids; do
    n="$(api_as "$who" POST "$base:runAggregationQuery" \
      "{\"structuredAggregationQuery\":{\"structuredQuery\":{\"from\":[{\"collectionId\":\"$c\"}]},\"aggregations\":[{\"alias\":\"n\",\"count\":{}}]}$rtj}" "$p" \
      | jq -r '.[0].result.aggregateFields.n.integerValue // "?"')" || n="?"
    printf '%s %s\n' "$c" "$n"
  done | sort
}

auth_user_count() {
  local p="$1" who="${2:-main}" total=0 next="" page
  while :; do
    page="$(api_as "$who" GET "https://identitytoolkit.googleapis.com/v1/projects/$p/accounts:batchGet?maxResults=1000${next:+&nextPageToken=$next}" "" "$p")" || return 1
    total=$((total + $(printf '%s' "$page" | jq '.users // [] | length')))
    next="$(printf '%s' "$page" | jq -r '.nextPageToken // empty')"
    [ -n "$next" ] || break
  done
  printf '%s' "$total"
}

# ---- runs -------------------------------------------------------------------
# run_ids_in <gs://prefix-holding-run-folders> [main|vault]: ids, oldest first.
run_ids_in() {
  local g=(gcloud); [ "${2:-main}" = "main" ] || g=("${GV[@]}")
  "${g[@]}" storage ls "$1/" 2>/dev/null | sed -nE 's#.*/([0-9]{8}T[0-9]{6}Z)/$#\1#p' | sort
}
# manifest_of <gs://run-path> [main|vault]
manifest_of() {
  local g=(gcloud); [ "${2:-main}" = "main" ] || g=("${GV[@]}")
  "${g[@]}" storage cat "$1/manifest.json" 2>/dev/null
}
# newest_good_run <gs://prefix> [main|vault]: id of the newest succeeded run.
newest_good_run() {
  local id
  for id in $(run_ids_in "$1" "${2:-main}" | sort -r | head -n 15); do
    if [ "$(manifest_of "$1/$id" "${2:-main}" | jq -r '.status // empty' 2>/dev/null)" = "succeeded" ]; then
      printf '%s' "$id"; return 0
    fi
  done
  return 1
}
print_manifest_line() {
  jq -r '"  \(.id)  \(.status | ascii_upcase)  " + ([.steps | to_entries[] | "\(.key) \(.value)"] | join(" · "))
         + "  · \([.firestore[]?.collections // {} | to_entries[] | .value] | add // 0) docs, \(.auth.users // 0) users, \([.storage[]?.objects] | add // 0) files"
         + (if (.errors | length) > 0 then "\n      " + (.errors | join("\n      ")) else "" end)'
}

# ---- preflight --------------------------------------------------------------
preflight() {
  if [ "$(uname -s)" = "Darwin" ]; then
    need_tool gcloud "brew install --cask google-cloud-sdk, then: gcloud auth login"
    need_tool jq "brew install jq"
  else
    need_tool gcloud "https://cloud.google.com/sdk/docs/install (or use Cloud Shell)"
    need_tool jq "sudo apt-get install jq"
  fi
  need_tool curl "comes with macOS; Linux: sudo apt-get install curl"
  check_tools
  local who
  who="$(gcloud config get-value account 2>/dev/null || true)"
  [ -n "$who" ] || die "gcloud is not logged in. Run: gcloud auth login"
  if [ -n "$VAULT_ACCOUNT" ]; then GV=(gcloud --account="$VAULT_ACCOUNT"); fi
  if [ "$AS_VAULT" = "1" ]; then
    say "  Account: $VAULT_ACCOUNT (vault owner; production is not used)"
    vtoken >/dev/null
  else
    say "  Account: $( [ -n "${GITHUB_ACTIONS:-}" ] && echo 'GitHub Actions service account' || echo "$who")"
    gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null 2>&1 || die "$who cannot see project $PROJECT_ID"
    token >/dev/null
  fi
}

# ---- setup ------------------------------------------------------------------
db_location() { api GET "$(fs_db "$PROJECT_ID" "${1:-(default)}")" | jq -r '.locationId // empty'; }

ensure_backup_bucket() {
  local loc life
  if bucket_exists_as "$BACKUP_BUCKET" gcloud; then
    info "gs://$BACKUP_BUCKET exists"
  else
    loc="$(db_location)" || die "cannot read the Firestore database of $PROJECT_ID"
    [ -n "$loc" ] || die "$PROJECT_ID has no (default) Firestore database"
    loc="$(bucket_location_for_db "$loc")"
    confirm "Create backup bucket gs://$BACKUP_BUCKET in $loc (the Firestore location)?" || die "stopped"
    run gcloud storage buckets create "gs://$BACKUP_BUCKET" --project "$PROJECT_ID" --location "$loc" \
      --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=30d \
      || die "could not create gs://$BACKUP_BUCKET (bucket names are global; set BACKUP_BUCKET to another name)"
  fi
  life="$WORKDIR/life.json"
  # No age rule on runs/: an age rule cannot count, so a long run of failed
  # backups would delete every good set. prune (after each good run) keeps
  # the newest KEEP_MIN_SETS good sets whatever their age.
  jq -n '{rule:[{action:{type:"Delete"},condition:{age:3,matchesPrefix:["drill/"]}}]}' >"$life"
  rrun gcloud storage buckets update "gs://$BACKUP_BUCKET" --lifecycle-file="$life" --soft-delete-duration=30d --quiet
}

cmd_setup() {
  info "Setting up backups for $PROJECT_ID"
  ensure_backup_bucket
  if [ -z "$CI_SA" ]; then
    warn "CI_SA is empty in $ENV_FILE. Service accounts in $PROJECT_ID:"
    gcloud iam service-accounts list --project "$PROJECT_ID" --format='value(email)' | sed 's/^/    /' >&2
    die "put the one GitHub Actions uses (the client_email in the deploy key secret) in CI_SA, then run setup again"
  fi
  info "Roles for the GitHub Actions service account $CI_SA"
  local role
  # Read everything, export Firestore, read password hashes, run and delete
  # drill-* databases (drill --here), read the config snapshot.
  for role in roles/datastore.importExportAdmin roles/datastore.viewer roles/datastore.owner \
      roles/firebaseauth.admin roles/firebasedatabase.viewer roles/firebaserules.viewer \
      roles/firebasehosting.viewer roles/firebase.viewer roles/cloudfunctions.viewer \
      roles/cloudscheduler.viewer roles/secretmanager.viewer roles/iam.securityReviewer \
      roles/serviceusage.serviceUsageConsumer; do
    rrun gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$CI_SA" \
      --role="$role" --condition=None --quiet --format=none
  done
  rrun gcloud storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" \
    --member="serviceAccount:$CI_SA" --role=roles/storage.objectAdmin --quiet --format=none
  local b
  for b in $(storage_buckets); do
    for role in roles/storage.objectViewer roles/storage.legacyBucketReader; do
      rrun gcloud storage buckets add-iam-policy-binding "gs://$b" \
        --member="serviceAccount:$CI_SA" --role="$role" --quiet --format=none
    done
  done
  say "  Done. New permissions take a few minutes to apply. Next: backup.sh protect, backup.sh offsite."
}

# ---- protect ----------------------------------------------------------------
add_lien() {
  local p="$1" reason="$2" g=("${@:3}")
  [ ${#g[@]} -gt 0 ] || g=(gcloud)
  if "${g[@]}" alpha resource-manager liens list --project "$p" --format='value(reason)' 2>/dev/null | grep -qF "$reason"; then
    info "deletion lien on $p already there"; return 0
  fi
  run "${g[@]}" alpha resource-manager liens create --project "$p" \
    --restrictions=resourcemanager.projects.delete --reason="$reason" --quiet \
    || warn "could not add a deletion lien on $p (needs: gcloud components install alpha); not critical"
}

cmd_protect() {
  info "Protecting $PROJECT_ID"
  confirm "Turn on point-in-time recovery + delete protection on every Firestore database, a daily Google-managed Firestore backup (kept $MANAGED_KEEP_DAYS days), 30-day soft delete on gs://$BACKUP_BUCKET, and a deletion lien on $PROJECT_ID?" || die "stopped"
  local db
  for db in $(firestore_databases); do
    rrun gcloud firestore databases update --database="$db" --project "$PROJECT_ID" --enable-pitr --delete-protection --quiet --format=none
    if gcloud firestore backups schedules list --database="$db" --project "$PROJECT_ID" --format=json 2>/dev/null | jq -e 'any(.[]; .dailyRecurrence)' >/dev/null; then
      say "  $db: daily managed backup already scheduled"
    else
      rrun gcloud firestore backups schedules create --database="$db" --project "$PROJECT_ID" \
        --recurrence=daily --retention="${MANAGED_KEEP_DAYS}d" --format=none
    fi
  done
  bucket_exists_as "$BACKUP_BUCKET" gcloud && rrun gcloud storage buckets update "gs://$BACKUP_BUCKET" --soft-delete-duration=30d --quiet
  add_lien "$PROJECT_ID" "Production $PROJECT_LABEL"
  say "  Firestore keeps every version for 7 days and cannot be deleted by mistake; Google keeps"
  say "  a daily copy for $MANAGED_KEEP_DAYS days; the project cannot be deleted until the lien is removed."
}

# ---- vault (off-site, archive, chain secrets) -------------------------------
# ensure_vault_project <project> <display name>: as the vault owner, create it
# (if missing), link the owner's own billing account, enable Storage.
ensure_vault_project() {
  local id="$1" name="$2" acct
  if "${GV[@]}" projects describe "$id" --format='value(projectId)' >/dev/null 2>&1; then
    info "project $id exists"
  else
    confirm "Create Google Cloud project $id owned by $VAULT_ACCOUNT?" || die "stopped"
    if ! run "${GV[@]}" projects create "$id" --name="$name"; then
      sleep 5
      "${GV[@]}" projects describe "$id" >/dev/null 2>&1 \
        || die "could not create $id. 'exceeded your allotted project quota' means $VAULT_ACCOUNT has too many projects; otherwise the id is taken worldwide (change it in $ENV_FILE)"
    fi
  fi
  if [ "$("${GV[@]}" billing projects describe "$id" --format='value(billingEnabled)' 2>/dev/null || true)" != "True" ]; then
    acct="$("${GV[@]}" billing accounts list --filter=open=true --format='value(name)' 2>/dev/null | head -n 1 | sed 's#^billingAccounts/##')"
    [ -n "$acct" ] || die "$VAULT_ACCOUNT has no open billing account. Add one at console.cloud.google.com/billing, then run again"
    rrun "${GV[@]}" billing projects link "$id" --billing-account="$acct" --format=none
  fi
  rrun "${GV[@]}" services enable storage.googleapis.com secretmanager.googleapis.com --project "$id"
}

# vault_bucket <bucket> <location> <storage class> <keep days or 0>
vault_bucket() {
  local b="$1" loc="$2" cls="$3" keep="$4" owner want life="$WORKDIR/vlife.json"
  if bucket_exists_as "$b" "${GV[@]}"; then
    # --raw: gcloud's standard bucket view has no project number.
    owner="$("${GV[@]}" storage buckets describe "gs://$b" --raw --format='value(projectNumber)' 2>/dev/null || true)"
    want="$("${GV[@]}" projects describe "$VAULT_PROJECT" --format='value(projectNumber)' 2>/dev/null || true)"
    [ "$owner" = "$want" ] || die "gs://$b exists but belongs to another project ($owner, not $VAULT_PROJECT $want)"
    info "gs://$b exists in $VAULT_PROJECT"
  else
    run "${GV[@]}" storage buckets create "gs://$b" --project "$VAULT_PROJECT" --location "$loc" \
      --default-storage-class="$cls" --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=30d \
      || die "could not create gs://$b (bucket names are global; change it in $ENV_FILE)"
  fi
  if [ "$keep" != "0" ]; then
    jq -n --argjson d "$keep" '{rule:[{action:{type:"Delete"},condition:{age:$d,matchesPrefix:["runs/"]}}]}' >"$life"
    rrun "${GV[@]}" storage buckets update "gs://$b" --lifecycle-file="$life" --soft-delete-duration=30d --quiet
  fi
}

check_vault_login() {
  local me
  me="$(gcloud config get-value account 2>/dev/null || true)"
  # Allowed, but the vault is then only as safe as that one account.
  [ "$VAULT_ACCOUNT" != "$me" ] || [ "$AS_VAULT" = "1" ] \
    || warn "$VAULT_ACCOUNT owns both $PROJECT_ID and the vault: losing that account loses both"
  vtoken >/dev/null
}

cmd_offsite() {
  [ -n "$OFFSITE_BUCKET" ] || die "OFFSITE_BUCKET is empty in $ENV_FILE"
  [ -n "$CI_SA" ] || die "CI_SA is empty in $ENV_FILE; run setup first"
  check_vault_login
  local loc
  loc="$(multi_region_for "$(db_location)")"
  info "Off-site bucket gs://$OFFSITE_BUCKET ($loc) in $VAULT_PROJECT, owned by $VAULT_ACCOUNT"
  confirm "Set it up (keeps $OFFSITE_KEEP_DAYS days; GitHub may add and read files, never delete)?" || die "stopped"
  ensure_vault_project "$VAULT_PROJECT" "YourBackupAgent vault"
  vault_bucket "$OFFSITE_BUCKET" "$loc" STANDARD "$OFFSITE_KEEP_DAYS"
  # Add and read only: a leaked GitHub key can never overwrite or delete copies.
  # Read is needed because `gcloud storage cp` looks at the destination (403
  # storage.objects.get otherwise); the key already reads the same sets in the project.
  rrun "${GV[@]}" storage buckets add-iam-policy-binding "gs://$OFFSITE_BUCKET" \
    --member="serviceAccount:$CI_SA" --role=roles/storage.objectCreator --quiet --format=none
  rrun "${GV[@]}" storage buckets add-iam-policy-binding "gs://$OFFSITE_BUCKET" \
    --member="serviceAccount:$CI_SA" --role=roles/storage.objectViewer --quiet --format=none
  add_lien "$VAULT_PROJECT" "YourBackupAgent vault: off-site backups and archives" "${GV[@]}"
  say "  The next backup run copies itself to gs://$OFFSITE_BUCKET (status shows Off-site ok)."
}

cmd_vault_secrets() {
  [ -n "$CHAIN_SECRETS" ] || die "CHAIN_SECRETS is empty in $ENV_FILE"
  check_vault_login
  info "Copying secrets into $VAULT_PROJECT Secret Manager (names $PROJECT_ID--<NAME>)"
  confirm "Copy the latest value of: $CHAIN_SECRETS?" || die "stopped"
  ensure_vault_project "$VAULT_PROJECT" "YourBackupAgent vault"
  local s dst
  for s in $CHAIN_SECRETS; do
    dst="$PROJECT_ID--$s"
    if ! gcloud secrets versions access latest --secret="$s" --project "$PROJECT_ID" >/dev/null 2>&1; then
      warn "cannot read $s in $PROJECT_ID (missing, or no access); skipped"; continue
    fi
    "${GV[@]}" secrets describe "$dst" --project "$VAULT_PROJECT" >/dev/null 2>&1 \
      || run "${GV[@]}" secrets create "$dst" --project "$VAULT_PROJECT" --replication-policy=automatic \
           --labels="source=$PROJECT_ID" --quiet --format=none
    if [ "$DRY_RUN" = "1" ]; then say "  + copy $s -> $dst"; continue; fi
    # The value goes from one command to the other through a pipe only.
    gcloud secrets versions access latest --secret="$s" --project "$PROJECT_ID" \
      | "${GV[@]}" secrets versions add "$dst" --project "$VAULT_PROJECT" --data-file=- --quiet --format=none \
      || die "could not copy $s"
    say "  $s -> $VAULT_PROJECT/$dst"
  done
  say "  Copy again after you rotate any of these keys."
}

# ---- backup run -------------------------------------------------------------
MANIFEST=""
mset() { local t="$WORKDIR/m.tmp"; jq "$@" "$MANIFEST" >"$t" && mv "$t" "$MANIFEST"; }
merror() { warn "$1"; mset --arg e "$1" '.errors += [$e]'; }

# snapshot_time: a whole minute about a minute ago, when point-in-time recovery
# is on (export and counts then read exactly the same moment); else empty.
snapshot_time() {
  if [ "$(api GET "$(fs_db "$PROJECT_ID" "$1")" | jq -r '.pointInTimeRecoveryEnablement // empty')" = "POINT_IN_TIME_RECOVERY_ENABLED" ]; then
    jq -rn 'now | floor | . - (. % 60) - 60 | todate'
  fi
}

step_firestore() {
  local dest="$1" db t loc op dir counts
  for db in $(firestore_databases); do
    dir="$(db_dir "$db")"
    t="$(snapshot_time "$db")" || t=""
    loc="$(db_location "$db")" || loc=""
    info "Firestore $db -> firestore/$dir${t:+ (as of $t)}"
    op="$(change main POST "$(fs_db "$PROJECT_ID" "$db"):exportDocuments" \
      "$(jq -nc --arg u "$dest/firestore/$dir" --arg t "$t" '{outputUriPrefix:$u} + (if $t != "" then {snapshotTime:$t} else {} end)')" \
      | jq -r '.name // empty')" || return 1
    if [ "$DRY_RUN" != "1" ]; then
      [ -n "$op" ] || { printf 'export of %s started no operation\n' "$db" >&2; return 1; }
      wait_op main "https://firestore.googleapis.com/v1/$op" "export of $db" || return 1
    fi
    counts="$(collection_counts "$PROJECT_ID" "$db" "$t" | jq -Rn '[inputs | split(" ") | {(.[0]): (.[1] | tonumber? // .)}] | add // {}')" || counts='{}'
    mset --arg db "$db" --arg loc "$loc" --arg t "$t" --argjson c "$counts" \
      '.firestore[$db] = {location: $loc, snapshotTime: (if $t == "" then null else $t end), collections: $c}'
    say "  $(printf '%s' "$counts" | jq 'length') collections, $(printf '%s' "$counts" | jq '[.[] | numbers] | add // 0') documents"
  done
}

step_storage() {
  local dest="$1" b n
  for b in $(storage_buckets); do
    info "Storage gs://$b -> storage/$b"
    rqrun gcloud storage rsync -r "gs://$b" "$dest/storage/$b" --quiet || return 1
    n="$(object_count_as "$dest/storage/$b" gcloud)"
    mset --arg b "$b" --argjson n "${n:-0}" '.storage[$b] = {objects: $n}'
    say "  $n files"
  done
}

step_auth() {
  local dest="$1" next="" i=0 page users="$WORKDIR/users.json" hash="$WORKDIR/hash-config.json" cfg err=""
  info "Auth users -> auth/"
  while :; do
    page="$(api GET "https://identitytoolkit.googleapis.com/v1/projects/$PROJECT_ID/accounts:batchGet?maxResults=1000${next:+&nextPageToken=$next}")" || return 1
    printf '%s' "$page" >"$WORKDIR/users-$i.json"
    next="$(printf '%s' "$page" | jq -r '.nextPageToken // empty')"
    i=$((i + 1))
    [ -n "$next" ] || break
  done
  jq -s '[.[] | .users // [] | .[]]' "$WORKDIR"/users-*.json >"$users"
  rm -f "$WORKDIR"/users-*.json
  if cfg="$(api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config" 2>"$WORKDIR/hash.err")"; then
    printf '%s' "$cfg" | jq '{hashConfig: (.signIn.hashConfig // null)}' >"$hash"
  else
    err="$(head -c 200 "$WORKDIR/hash.err")"
    jq -n --arg e "$err" '{hashConfig: null, error: $e}' >"$hash"
  fi
  run gcloud storage cp "$users" "$hash" "$dest/auth/" --quiet || return 1
  mset --slurpfile u "$users" --slurpfile h "$hash" '.auth = {
      users: ($u[0] | length),
      withPassword: ([$u[0][] | select(.passwordHash or .passwordUpdatedAt)] | length),
      withPasswordHash: ([$u[0][] | select(.passwordHash)] | length),
      hashConfig: ($h[0].hashConfig != null)
    }'
  rm -f "$users" "$hash"
  say "  $(jq -r '.auth | "\(.users) users, \(.withPasswordHash) with a password hash, hash key \(if .hashConfig then "saved" else "MISSING" end)"' "$MANIFEST")"
  if [ "$(jq -r '.auth.withPasswordHash < .auth.withPassword or (.auth.withPassword > 0 and (.auth.hashConfig | not))' "$MANIFEST")" = "true" ]; then
    merror "auth: password hashes or the hash key are missing (the service account needs roles/firebaseauth.admin); password users would have to reset"
    return 1
  fi
}

# RTDB REST needs the firebase.database scope, which only service-account
# tokens can ask gcloud for; a person's login uses the Firebase CLI instead.
rtdb_get() {
  local url="$1" out="$2" tok
  if tok="$(gcloud auth print-access-token --scopes=https://www.googleapis.com/auth/firebase.database,https://www.googleapis.com/auth/userinfo.email 2>/dev/null)"; then
    curl -sSf -H "Authorization: Bearer $tok" "$url/.json?format=export" -o "$out" && return 0
  fi
  if command -v firebase >/dev/null 2>&1; then
    firebase database:get / --project "$PROJECT_ID" --instance "$3" --export -o "$out" >/dev/null && return 0
  fi
  printf 'cannot read %s (install the Firebase CLI: npm install -g firebase-tools, then firebase login)\n' "$url" >&2
  return 1
}

step_rtdb() {
  local dest="$1" id url f bytes any=0
  while read -r id url; do
    [ -n "$id" ] || continue
    any=1
    info "Realtime Database $id -> rtdb/$id.json"
    f="$WORKDIR/rtdb-$id.json"
    if [ "$DRY_RUN" = "1" ]; then say "  + read $url"; continue; fi
    rtdb_get "$url" "$f" "$id" || return 1
    jq empty "$f" 2>/dev/null || { printf 'rtdb %s: not JSON\n' "$id" >&2; return 1; }
    bytes="$(wc -c <"$f" | tr -d ' ')"
    if [ "$(head -c 4 "$f")" = "null" ]; then
      say "  empty"
    else
      run gcloud storage cp "$f" "$dest/rtdb/$id.json" --quiet || return 1
    fi
    mset --arg id "$id" --arg url "$url" --argjson b "$bytes" --argjson k "$(jq 'if type == "object" then length else 0 end' "$f")" \
      '.rtdb[$id] = {url: $url, bytes: $b, topKeys: $k}'
    rm -f "$f"
  done <<EOF
$(rtdb_instances)
EOF
  [ "$any" = "1" ] || say "  (no Realtime Database)"
}

# The live project settings that are not (only) in git. Best effort: what
# cannot be read is listed as a warning. Secret values are never read.
STRIP='walk(if type == "object" then with_entries(if (.key | test("secret|signerKey|saltSeparator|apiKey|privateKey|password"; "i")) and (.value | type) == "string" then .value = "(set, not copied)" else . end) else . end)'
step_config() {
  local dest="$1" dir="$WORKDIR/config" p="$PROJECT_ID" n=0 warns=() r
  mkdir -p "$dir"
  info "Project config -> config/"
  grab() {
    local name="$1"; shift
    if "$@" >"$dir/$name.json" 2>"$WORKDIR/grab.err" && jq empty "$dir/$name.json" 2>/dev/null; then
      n=$((n + 1))
    else
      rm -f "$dir/$name.json"
      warns+=("$name: $(head -c 150 "$WORKDIR/grab.err" | tr '\n' ' ')")
    fi
  }
  all_pages() { # url key
    local url="$1" key="$2" page="" out="[]" body sep
    while :; do
      sep='?'; case "$url" in *\?*) sep='&' ;; esac
      body="$(api GET "$url${page:+${sep}pageToken=$page}")" || return 1
      out="$(jq -c --argjson o "$out" --arg k "$key" '$o + (.[$k] // [])' <<<"$body")"
      page="$(jq -r '.nextPageToken // empty' <<<"$body")"
      [ -n "$page" ] || break
    done
    printf '%s' "$out"
  }
  rules() {
    local rel out="[]" r rs
    rel="$(api GET "https://firebaserules.googleapis.com/v1/projects/$p/releases?pageSize=50")" || return 1
    for r in $(jq -r '.releases[]? | "\(.name)|\(.rulesetName)"' <<<"$rel"); do
      rs="$(api GET "https://firebaserules.googleapis.com/v1/${r#*|}")" || return 1
      out="$(jq -c --argjson o "$out" --arg n "${r%%|*}" '$o + [{release: $n, files: (.source.files // [])}]' <<<"$rs")"
    done
    printf '%s' "$out"
  }
  dbs_full() { local db o="[]"; for db in $(firestore_databases); do o="$(jq -c --argjson o "$o" '$o + [.]' <<<"$(api GET "$(fs_db "$p" "$db")")")"; done; printf '%s' "$o"; }
  indexes() { local db o="{}"; for db in $(firestore_databases); do o="$(jq -c --argjson o "$o" --arg d "$db" '$o + {($d): .}' <<<"$(all_pages "$(fs_db "$p" "$db")/collectionGroups/-/indexes" indexes)")"; done; printf '%s' "$o"; }
  fields() { local db o="{}"; for db in $(firestore_databases); do o="$(jq -c --argjson o "$o" --arg d "$db" '$o + {($d): .}' <<<"$(all_pages "$(fs_db "$p" "$db")/collectionGroups/-/fields?filter=indexConfig.usesAncestorConfig:false" fields)")"; done; printf '%s' "$o"; }
  authcfg() { api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$p/config" | jq "del(.signIn.hashConfig) | $STRIP"; }
  idps() { api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$p/defaultSupportedIdpConfigs" | jq "$STRIP"; }
  hosting() {
    local s o="[]" site
    s="$(api GET "https://firebasehosting.googleapis.com/v1beta1/projects/$p/sites")" || return 1
    for site in $(jq -r '.sites[]?.name | split("/") | last' <<<"$s"); do
      o="$(jq -c --argjson o "$o" --arg s "$site" --argjson d "$(api GET "https://firebasehosting.googleapis.com/v1beta1/projects/$p/sites/$site/customDomains" 2>/dev/null || echo '{}')" \
        '$o + [{site: $s, customDomains: ($d.customDomains // [] | map({name, hostState, ownershipState}))}]' <<<'{}')"
    done
    printf '%s' "$o"
  }
  functions_list() {
    all_pages "https://cloudfunctions.googleapis.com/v2/projects/$p/locations/-/functions?pageSize=500" functions \
      | jq '[.[] | {name, state, environment, runtime: .buildConfig.runtime, trigger: .eventTrigger, serviceAccount: .serviceConfig.serviceAccountEmail,
                    memory: .serviceConfig.availableMemory, envVars: ((.serviceConfig.environmentVariables // {}) | keys),
                    secrets: [(.serviceConfig.secretEnvironmentVariables // [])[] | .secret], updateTime}]'
  }
  schedulers() { local rg o="[]"; for rg in $REGIONS; do o="$(jq -c --argjson o "$o" '$o + (.jobs // [] | map({name, schedule, timeZone, state, target: (.httpTarget.uri // .pubsubTarget.topicName // null)}))' <<<"$(api GET "https://cloudscheduler.googleapis.com/v1/projects/$p/locations/$rg/jobs")")"; done; printf '%s' "$o"; }
  secrets() { all_pages "https://secretmanager.googleapis.com/v1/projects/$p/secrets?pageSize=250" secrets | jq '[.[] | {name: (.name | split("/") | last), createTime, labels}]'; }
  buckets() { api GET "https://storage.googleapis.com/storage/v1/b?project=$p&projection=full" | jq '[.items[]? | {name, location, storageClass, versioning, softDeletePolicy, retentionPolicy, lifecycle, cors, iamConfiguration}]'; }
  kms() {
    local rings o="[]" ring
    rings="$(api GET "https://cloudkms.googleapis.com/v1/projects/$p/locations/global/keyRings")" || return 1
    for ring in $(jq -r '.keyRings[]?.name' <<<"$rings"); do
      o="$(jq -c --argjson o "$o" '$o + [.cryptoKeys[]? | {name, purpose, versionTemplate, rotationPeriod}]' <<<"$(api GET "https://cloudkms.googleapis.com/v1/$ring/cryptoKeys")")"
    done
    printf '%s' "$o"
  }
  services() { all_pages "https://serviceusage.googleapis.com/v1/projects/$p/services?filter=state:ENABLED&pageSize=200" services | jq '[.[].config.name]'; }

  grab firestore-databases dbs_full
  grab firestore-indexes indexes
  grab firestore-field-overrides fields
  grab rules rules
  grab auth-config authcfg
  grab auth-providers idps
  grab hosting hosting
  grab web-apps api GET "https://firebase.googleapis.com/v1beta1/projects/$p/webApps"
  grab functions functions_list
  grab scheduler-jobs schedulers
  grab secrets-inventory secrets
  grab buckets buckets
  grab kms-keys kms
  grab iam-policy api POST "https://cloudresourcemanager.googleapis.com/v1/projects/$p:getIamPolicy" '{}'
  grab enabled-services services
  run gcloud storage cp "$dir"/*.json "$dest/config/" --quiet || return 1
  local w="[]"
  for r in ${warns[@]+"${warns[@]}"}; do w="$(jq -c --argjson w "$w" --arg r "$r" '$w + [$r]' <<<'{}')"; done
  mset --argjson n "$n" --argjson w "$w" '.config = {files: $n, warnings: $w}'
  say "  $n files${warns[0]+, ${#warns[@]} could not be read (see status)}"
  [ "$n" -gt 0 ]
}

# do_run [trigger]: one complete backup. Prints the id last; exits non-zero on failure.
RUN_PATH=""
do_run() {
  local id dest step ok=1 required
  id="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="gs://$BACKUP_BUCKET/runs/$id"
  RUN_PATH="$dest"; RUN_ID="$id"
  MANIFEST="$WORKDIR/manifest.json"
  jq -n --arg id "$id" --arg p "$PROJECT_ID" --arg t "$TRIGGER" --argjson k "$KIT_VERSION" \
    --arg sha "${GITHUB_SHA:-$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || true)}" --arg kr "$KIT_REF" \
    '{kit: $k, kitRef: $kr, project: $p, id: $id, trigger: $t, startedAt: (now | todate), commit: $sha, status: "running", steps: {}, firestore: {}, storage: {}, auth: null, rtdb: {}, config: null, errors: []}' >"$MANIFEST"
  info "Backup $id of $PROJECT_ID -> $dest"
  bucket_exists_as "$BACKUP_BUCKET" gcloud || die "gs://$BACKUP_BUCKET does not exist (or no access). Run: backup-kit/backup.sh setup"

  for step in firestore storage auth rtdb config; do
    if "step_$step" "$dest" 2>"$WORKDIR/step.err"; then
      cat "$WORKDIR/step.err" >&2
      mset --arg s "$step" '.steps[$s] = "ok"'
    else
      cat "$WORKDIR/step.err" >&2
      mset --arg s "$step" '.steps[$s] = "failed"'
      merror "$step: $(tail -n 3 "$WORKDIR/step.err" | tr '\n' ' ' | head -c 300)"
      [ "$step" = "config" ] || ok=0
    fi
  done
  required="$ok"

  if [ "$required" = "1" ] && [ -n "$OFFSITE_BUCKET" ] && [ "$TRIGGER" != "archive" ]; then
    info "Off-site copy -> gs://$OFFSITE_BUCKET/runs/$id/"
    # Copies only (the service account may create files there, nothing else).
    if qrun gcloud storage cp -r "$dest/*" "gs://$OFFSITE_BUCKET/runs/$id/" --quiet 2>"$WORKDIR/off.err"; then
      mset '.steps.offsite = "ok"'
    else
      cat "$WORKDIR/off.err" >&2
      mset '.steps.offsite = "failed"'
      merror "offsite: $(tail -n 2 "$WORKDIR/off.err" | tr '\n' ' ' | head -c 300)"
      ok=0
    fi
  fi

  mset --arg s "$([ "$required" = "1" ] && echo succeeded || echo failed)" '.status = $s | .finishedAt = (now | todate)'
  run gcloud storage cp "$MANIFEST" "$dest/manifest.json" --quiet || die "could not write the manifest"
  if [ "$(jq -r '.steps.offsite // empty' "$MANIFEST")" = "ok" ]; then
    # Written last, so an off-site manifest means a complete off-site copy.
    run gcloud storage cp "$MANIFEST" "gs://$OFFSITE_BUCKET/runs/$id/manifest.json" --quiet \
      || { warn "could not write the off-site manifest"; ok=0; }
  fi
  jq -c . "$MANIFEST" | print_manifest_line
  [ "$ok" = "1" ]
}

cmd_run() {
  confirm "Back up $PROJECT_ID now?" || die "stopped"
  if do_run; then
    info "BACKUP SUCCEEDED: $RUN_ID"
    # Only after a good run, so failing nights never delete anything.
    prune_sets main "gs://$BACKUP_BUCKET/runs" "$BACKUP_KEEP_DAYS" || warn "pruning old backup sets failed; the backup itself is fine"
  else
    die "BACKUP FAILED: $RUN_ID (see the errors above)"
  fi
}

# ---- check / status ---------------------------------------------------------
protection_report() {
  local db d
  for db in $(firestore_databases); do
    d="$(api GET "$(fs_db "$PROJECT_ID" "$db")")" || { warn "cannot read database $db"; continue; }
    jq -r --arg db "$db" '"  \($db): \(.locationId) · point-in-time recovery \(if .pointInTimeRecoveryEnablement == "POINT_IN_TIME_RECOVERY_ENABLED" then "on" else "OFF" end) · delete protection \(if .deleteProtectionState == "DELETE_PROTECTION_ENABLED" then "on" else "OFF" end)"' <<<"$d"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
      jq -r '(if .pointInTimeRecoveryEnablement != "POINT_IN_TIME_RECOVERY_ENABLED" then "::warning::Firestore point-in-time recovery is off (backup.sh protect)" else empty end),
             (if .deleteProtectionState != "DELETE_PROTECTION_ENABLED" then "::warning::Firestore delete protection is off (backup.sh protect)" else empty end)' <<<"$d"
    fi
  done
  gcloud firestore backups list --project "$PROJECT_ID" --format=json 2>/dev/null \
    | jq -r 'map(select(.state == "READY")) | sort_by(.snapshotTime) | if length == 0 then "  Google-managed backups: none ready\(if env.GITHUB_ACTIONS then "\n::warning::No Google-managed Firestore backup is ready (backup.sh protect)" else "" end)" else "  Google-managed backups: \(length) ready, newest \(last.snapshotTime)" end' \
    || warn "cannot list Google-managed Firestore backups"
}

cmd_check() {
  local ids id m newest="" good="" age fail=0
  info "Backups of $PROJECT_ID (newest first)"
  ids="$(run_ids_in "gs://$BACKUP_BUCKET/runs" | sort -r | head -n 7)"
  [ -n "$ids" ] || die "no backup runs in gs://$BACKUP_BUCKET/runs/"
  for id in $ids; do
    m="$(manifest_of "gs://$BACKUP_BUCKET/runs/$id" || true)"
    [ -n "$m" ] || m="{\"id\":\"$id\",\"status\":\"incomplete\",\"steps\":{},\"errors\":[]}"
    [ -n "$newest" ] || newest="$m"
    [ -n "$good" ] || [ "$(jq -r .status <<<"$m")" != "succeeded" ] || good="$m"
    jq -c . <<<"$m" | print_manifest_line
  done
  if [ -z "$good" ]; then
    printf '::error::No successful backup among the last %s runs\n' "$(wc -w <<<"$ids" | tr -d ' ')"; exit 1
  fi
  age="$(jq -r '(now - (.startedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) / 3600 | floor' <<<"$good")"
  say "  newest good backup: $(jq -r .id <<<"$good") (${age}h ago)"
  [ "$age" -le "$MAX_AGE_HOURS" ] || { echo "::error::Newest good backup is ${age}h old (limit ${MAX_AGE_HOURS}h)"; fail=1; }
  [ "$(jq -r .status <<<"$newest")" != "failed" ] || { echo "::error::The newest backup run failed: $(jq -r '.errors | join("; ")' <<<"$newest" | head -c 300)"; fail=1; }
  if [ -n "$OFFSITE_BUCKET" ] && [ "$(jq -r '.steps.offsite // "missing"' <<<"$good")" != "ok" ]; then
    echo "::error::The off-site copy of the newest good backup did not succeed"; fail=1
  fi
  [ "$(jq -r '.config.warnings | length' <<<"$good")" = "0" ] || echo "::warning::Config snapshot could not read $(jq -r '.config.warnings | length' <<<"$good") part(s): $(jq -r '[.config.warnings[] | split(":")[0]] | join(", ")' <<<"$good")"
  info "Protection"
  protection_report
  exit "$fail"
}

cmd_status() {
  local id m
  info "Recent backups (gs://$BACKUP_BUCKET/runs/)"
  for id in $(run_ids_in "gs://$BACKUP_BUCKET/runs" | sort -r | head -n 10); do
    m="$(manifest_of "gs://$BACKUP_BUCKET/runs/$id" || true)"
    if [ -n "$m" ]; then jq -c . <<<"$m" | print_manifest_line; else say "  $id  INCOMPLETE (no manifest: still running, or it died)"; fi
  done
  id="$(newest_good_run "gs://$BACKUP_BUCKET/runs" || true)"
  if [ -n "$id" ]; then
    info "Newest good backup $id"
    manifest_of "gs://$BACKUP_BUCKET/runs/$id" | jq -r '
      (.firestore | to_entries[] | "  Firestore \(.key) (\(.value.location), \(if .value.snapshotTime then "as of \(.value.snapshotTime)" else "not point-in-time" end))", (.value.collections | to_entries[] | "    \(.key | .[0:34] | . + (" " * (34 - length))) \(.value)")),
      (.storage | to_entries[] | "  Storage \(.key): \(.value.objects) files"),
      (if .auth then "  Auth: \(.auth.users) users, \(.auth.withPasswordHash)/\(.auth.withPassword) password hashes, hash key \(if .auth.hashConfig then "saved" else "missing" end)" else empty end),
      (.rtdb | to_entries[] | "  Realtime Database \(.key): \(.value.bytes) bytes"),
      (if .config then "  Config: \(.config.files) files" + (if (.config.warnings | length) > 0 then "\n    " + (.config.warnings | join("\n    ")) else "" end) else empty end)'
  fi
  info "Protection"
  protection_report
  info "Buckets"
  say "  Keeps the newest $KEEP_MIN_SETS good sets always; other good sets $BACKUP_KEEP_DAYS days (vault $OFFSITE_KEEP_DAYS), failed or incomplete ones 3 days (backup.sh prune)"
  gcloud storage buckets describe "gs://$BACKUP_BUCKET" --format=json 2>/dev/null \
    | jq -r '"  gs://\(.name)  \(.location)  soft delete \((.soft_delete_policy.retentionDurationSeconds // "0") | tonumber / 86400 | floor) days  lifecycle: \([.lifecycle_config.rule[]? | "\(.action.type) \(.condition.matches_prefix // [] | join(",")) after \(.condition.age) days"] | join("; "))"' \
    || warn "cannot read gs://$BACKUP_BUCKET"
  if [ -n "$OFFSITE_BUCKET" ]; then
    if [ -n "$VAULT_ACCOUNT" ] && gcloud auth print-access-token "$VAULT_ACCOUNT" >/dev/null 2>&1; then
      id="$(newest_good_run "gs://$OFFSITE_BUCKET/runs" vault || true)"
      say "  gs://$OFFSITE_BUCKET (off-site, $VAULT_ACCOUNT): $(run_ids_in "gs://$OFFSITE_BUCKET/runs" vault | wc -l | tr -d ' ') runs, newest complete ${id:-none}"
    else
      say "  gs://$OFFSITE_BUCKET (off-site; log in as $VAULT_ACCOUNT to inspect it)"
    fi
  fi
  info "Live counts"
  say "  Auth users: $(auth_user_count "$PROJECT_ID" || echo '?')"
}

# ---- prune / delete ---------------------------------------------------------
# cutoff_id <days>: the run id of that many days ago (ids sort as times).
cutoff_id() { jq -nr --argjson d "$1" '(now - $d * 86400) | strftime("%Y%m%dT%H%M%SZ")'; }

# set_state <gs://root> <id> <main|vault>: succeeded, failed, incomplete (no
# manifest) or unknown (could not read it: never deleted).
set_state() {
  local g=(gcloud) files st
  [ "$3" = "main" ] || g=("${GV[@]}")
  files="$("${g[@]}" storage ls "$1/$2/" 2>/dev/null)" || { echo unknown; return; }
  if ! grep -q '/manifest\.json$' <<<"$files"; then echo incomplete; return; fi
  st="$(manifest_of "$1/$2" "$3" | jq -r '.status // empty' 2>/dev/null || true)"
  case "$st" in succeeded|failed) echo "$st" ;; *) echo unknown ;; esac
}

# prune_plan <main|vault> <gs://root> <keep days>: "<id> <state> <why>" for
# every set to delete. The newest KEEP_MIN_SETS good sets are never listed.
prune_plan() {
  local where="$1" root="$2" days="$3" id st good=0 old stale
  old="$(cutoff_id "$days")"; stale="$(cutoff_id 3)"
  for id in $(run_ids_in "$root" "$where" | sort -r); do
    st="$(set_state "$root" "$id" "$where")"
    case "$st" in
      succeeded)
        good=$((good + 1))
        [ "$good" -gt "$KEEP_MIN_SETS" ] && [[ "$id" < "$old" ]] && echo "$id $st older than $days days" ;;
      failed|incomplete)
        [[ "$id" < "$stale" ]] && echo "$id $st older than 3 days" ;;
    esac
  done
  return 0
}

# good_set_count <main|vault> <gs://root>
good_set_count() {
  local id n=0
  for id in $(run_ids_in "$2" "$1"); do
    [ "$(set_state "$2" "$id" "$1")" != "succeeded" ] || n=$((n + 1))
  done
  echo "$n"
}

rm_set() {
  local g=(gcloud); [ "$1" = "main" ] || g=("${GV[@]}")
  rrun "${g[@]}" storage rm -r "$2/$3" --quiet >/dev/null
}

# prune_sets <main|vault> <gs://root> <keep days>
prune_sets() {
  local where="$1" root="$2" days="$3" plan n id st
  plan="$(prune_plan "$where" "$root" "$days")"
  info "Old backup sets in $root (keep the newest $KEEP_MIN_SETS good sets, others $days days)"
  if [ -z "$plan" ]; then say "  nothing to delete"; return 0; fi
  n="$(wc -l <<<"$plan" | tr -d ' ')"
  sed 's/^/  delete /' <<<"$plan"
  confirm "Delete these $n set(s)? (recoverable for 30 days through soft delete)" || { say "  kept them"; return 0; }
  while read -r id st _; do
    rm_set "$where" "$root" "$id" || { warn "could not delete $id ($st)"; return 1; }
  done <<<"$plan"
  say "  deleted $n set(s)"
}

vault_root() { printf 'gs://%s/runs' "$OFFSITE_BUCKET"; }

cmd_prune() {
  if [ "$VAULT" = "1" ]; then
    check_vault_login
    prune_sets vault "$(vault_root)" "$OFFSITE_KEEP_DAYS"
  else
    prune_sets main "gs://$BACKUP_BUCKET/runs" "$BACKUP_KEEP_DAYS"
  fi
}

cmd_delete() {
  local where=main root="gs://$BACKUP_BUCKET/runs" st n
  if [ "$VAULT" = "1" ]; then check_vault_login; where=vault; root="$(vault_root)"; fi
  st="$(set_state "$root" "$RUN_ID" "$where")"
  [ "$st" != "unknown" ] || die "cannot read $root/$RUN_ID (no such set, or no access)"
  if [ "$st" = "succeeded" ]; then
    n="$(good_set_count "$where" "$root")"
    [ "$n" -gt "$KEEP_MIN_SETS" ] || die "$RUN_ID is one of the last $n good sets in $root; at least $KEEP_MIN_SETS are always kept (KEEP_MIN_SETS)"
  fi
  confirm "Delete backup set $RUN_ID ($st) from $root? (recoverable for 30 days through soft delete)" || die "stopped"
  rm_set "$where" "$root" "$RUN_ID" || die "could not delete $RUN_ID"
  info "Deleted $RUN_ID from $root"
}

# ---- restore ----------------------------------------------------------------
# source_path [project]: the gs:// folder holding run folders for --from.
source_root() {
  case "${FROM:-offsite}" in
    offsite) printf 'gs://%s/runs' "$OFFSITE_BUCKET" ;;
    archive) printf 'gs://%s/archive/%s' "$ARCHIVE_BUCKET" "$PROJECT_ID" ;;
    gs://*) printf '%s' "${FROM%/}" ;;
  esac
}

# auth_batch_body <users.json> <hash-config.json> <from>: accounts:batchGet
# records -> accounts:batchCreate body for users from..from+999.
auth_batch_body() {
  jq -c --argjson from "$3" --slurpfile h "$2" '
    ($h[0].hashConfig // {}) as $hc
    | {users: (.[$from:$from+1000] | map(
        {localId, email, emailVerified, displayName, photoUrl, phoneNumber, disabled,
         createdAt, lastLoginAt, customAttributes,
         passwordHash: (if $hc.signerKey then .passwordHash else null end),
         salt: (if $hc.signerKey then .salt else null end),
         providerUserInfo: [(.providerUserInfo // [])[] | select(.providerId != "password" and .providerId != "phone")
                            | {providerId, rawId, email, displayName, photoUrl} | with_entries(select(.value != null))],
         mfaInfo: ((.mfaInfo // []) | map({mfaEnrollmentId, displayName, phoneInfo, enrolledAt} | with_entries(select(.value != null))))
        } | with_entries(select(.value != null and .value != [])))) }
    + (if $hc.signerKey then {hashAlgorithm: ($hc.algorithm // "SCRYPT"), signerKey: $hc.signerKey, saltSeparator: ($hc.saltSeparator // ""),
                              rounds: ($hc.rounds | tonumber), memoryCost: ($hc.memoryCost | tonumber)} else {} end)' "$1"
}

# ensure_default_bucket <main|vault> <project>: the Firebase default Storage bucket.
ensure_default_bucket() {
  change "$1" POST "https://firebasestorage.googleapis.com/v1alpha/projects/$2/defaultBucket" '{"location":"US-CENTRAL1"}' "$2" >/dev/null 2>&1 || return 1
  [ "$DRY_RUN" = "1" ] || sleep 10
}

# restore_into <who main|vault> <target project> <gs://run path>: Firestore,
# Storage, Auth, RTDB. Leaves expected-vs-restored counts in $WORKDIR/compare.
restore_into() {
  local who="$1" target="$2" src="$3" g=(gcloud) m db dir loc op num agent role b tb n try users hash body res failed i want got
  [ "$who" = "main" ] || g=("${GV[@]}")
  m="$WORKDIR/src-manifest.json"
  "${g[@]}" storage cat "$src/manifest.json" >"$m" 2>/dev/null || die "no manifest.json in $src (incomplete backup, or no access)"
  [ "$(jq -r .status "$m")" = "succeeded" ] || die "backup $src did not succeed; pick another (--run ID)"
  info "Restoring $(jq -r .id "$m") from $src into $target"

  # Firestore import runs as the target's Firestore service agent, which must read the source bucket.
  num="$("${g[@]}" projects describe "$target" --format='value(projectNumber)')"
  agent="service-$num@gcp-sa-firestore.iam.gserviceaccount.com"
  run "${g[@]}" beta services identity create --service=firestore.googleapis.com --project "$target" --quiet >/dev/null 2>&1 || true
  b="$(printf '%s' "$src" | sed -E 's#^gs://([^/]+).*#\1#')"
  for role in roles/storage.objectViewer roles/storage.legacyBucketReader; do
    rrun "${g[@]}" storage buckets add-iam-policy-binding "gs://$b" --member="serviceAccount:$agent" --role="$role" --quiet --format=none
  done

  : >"$WORKDIR/compare"
  for db in $(jq -r '.firestore | keys[]' "$m"); do
    dir="$(db_dir "$db")"
    loc="$(jq -r --arg d "$db" '.firestore[$d].location' "$m")"
    if ! api_as "$who" GET "$(fs_db "$target" "$db")" "" "$target" >/dev/null 2>&1; then
      for try in 1 2 3 4 5 6 7 8 9 10; do
        run "${g[@]}" firestore databases create --database="$db" --location="$loc" --project "$target" --format=none && break
        [ "$try" = "10" ] && die "could not create database $db in $target"
        warn "database $db not created yet (a deleted one takes a few minutes to free its name); retrying in 60s"; sleep 60
      done
    fi
    info "Firestore import $db (waits until done)"
    # An import only writes documents, so repeating it is safe. New
    # permissions take a few minutes to apply, so keep trying for ~5 minutes.
    for try in 1 2 3 4 5 6 7 8 9 10; do
      if op="$(change "$who" POST "$(fs_db "$target" "$db"):importDocuments" "{\"inputUriPrefix\":\"$src/firestore/$dir\"}" "$target" | jq -r '.name // empty')" \
        && { [ "$DRY_RUN" = "1" ] || wait_op "$who" "https://firestore.googleapis.com/v1/$op" "import of $db" "$target"; }; then
        break
      fi
      [ "$try" = "10" ] && die "Firestore import of $db failed (see above)"
      warn "import refused (new database or new permissions take a few minutes); trying again in 30s"; sleep 30
    done
    [ "$DRY_RUN" = "1" ] && continue
    collection_counts "$target" "$db" "" "$who" >"$WORKDIR/got.txt"
    jq -r --arg d "$db" '.firestore[$d].collections | to_entries[] | "\(.key) \(.value)"' "$m" | sort >"$WORKDIR/want.txt"
    for n in $(cut -d' ' -f1 "$WORKDIR/want.txt" "$WORKDIR/got.txt" | sort -u); do
      want="$(awk -v c="$n" '$1==c{print $2}' "$WORKDIR/want.txt")"; got="$(awk -v c="$n" '$1==c{print $2}' "$WORKDIR/got.txt")"
      printf 'firestore %s/%s %s %s\n' "$db" "$n" "${want:-0}" "${got:-0}" >>"$WORKDIR/compare"
    done
  done

  for b in $(jq -r '.storage | keys[]' "$m"); do
    if [ "$(jq -r --arg b "$b" '.storage[$b].objects' "$m")" = "0" ]; then
      printf 'storage %s 0 0\n' "$b" >>"$WORKDIR/compare"; continue
    fi
    case "$b" in
      *.firebasestorage.app|*.appspot.com) tb="$target.firebasestorage.app" ;;
      *) tb="$target-$(printf '%s' "$b" | tr -c 'a-z0-9-\n' '-' | cut -c1-40)" ;;
    esac
    if ! bucket_exists_as "$tb" "${g[@]}"; then
      case "$tb" in
        *.firebasestorage.app) ensure_default_bucket "$who" "$target" || die "gs://$tb does not exist; turn on Storage in the Firebase console of $target" ;;
        *) run "${g[@]}" storage buckets create "gs://$tb" --project "$target" --location US --uniform-bucket-level-access --quiet ;;
      esac
    fi
    info "Storage $b -> gs://$tb"
    rqrun "${g[@]}" storage rsync -r "$src/storage/$b" "gs://$tb" --quiet
    [ "$DRY_RUN" = "1" ] || printf 'storage %s %s %s\n' "$b" "$(jq -r --arg b "$b" '.storage[$b].objects' "$m")" "$(object_count_as "gs://$tb" "${g[@]}")" >>"$WORKDIR/compare"
  done

  if [ "$(jq -r '.auth.users // 0' "$m")" != "0" ]; then
    info "Auth users"
    users="$WORKDIR/users.json"; hash="$WORKDIR/hash-config.json"
    retry "${g[@]}" storage cp "$src/auth/users.json" "$users" --quiet >/dev/null 2>&1 || die "could not download users.json"
    retry "${g[@]}" storage cp "$src/auth/hash-config.json" "$hash" --quiet >/dev/null 2>&1 || printf '{}' >"$hash"
    jq -e 'type == "array"' "$users" >/dev/null || die "users.json is not a list of users"
    [ -n "$(jq -r '.hashConfig.signerKey // empty' "$hash")" ] || warn "no password hash key in the backup: password users must use 'forgot password'"
    i=0; failed=0; n="$(jq length "$users")"
    while [ "$i" -lt "$n" ]; do
      body="$(auth_batch_body "$users" "$hash" "$i")"
      res="$(change "$who" POST "https://identitytoolkit.googleapis.com/v1/projects/$target/accounts:batchCreate" "$body" "$target")" \
        || die "Auth import failed (is Authentication set up in $target?)"
      failed=$((failed + $(jq '.error // [] | length' <<<"$res")))
      jq -r '.error // [] | .[:5][] | "  user #\(.index): \(.message)"' <<<"$res" >&2
      i=$((i + 1000))
    done
    rm -f "$users" "$hash"
    [ "$DRY_RUN" = "1" ] || printf 'auth users %s %s\n' "$n" "$(auth_user_count "$target" "$who")" >>"$WORKDIR/compare"
    [ "$failed" = "0" ] || warn "$failed users were not imported"
  fi

  for b in $(jq -r '.rtdb | to_entries[] | select(.value.bytes > 4) | .key' "$m"); do
    info "Realtime Database $b"
    command -v firebase >/dev/null 2>&1 || die "restoring the Realtime Database needs the Firebase CLI: npm install -g firebase-tools && firebase login"
    retry "${g[@]}" storage cp "$src/rtdb/$b.json" "$WORKDIR/rtdb.json" --quiet >/dev/null 2>&1 || die "could not download rtdb/$b.json"
    run firebase database:set / "$WORKDIR/rtdb.json" --project "$target" --instance "$target-default-rtdb" --force \
      || die "could not restore the Realtime Database (create it first in the Firebase console of $target)"
  done
}

# compare_report: prints the table; returns 1 if anything differs.
compare_report() {
  local bad=0 kind what want got
  printf '  %-44s %10s %10s\n' "what" "backup" "restored"
  while read -r kind what want got; do
    [ -n "$kind" ] || continue
    printf '  %-44s %10s %10s%s\n' "$kind $what" "${want:-0}" "${got:-0}" "$([ "${want:-0}" = "${got:-0}" ] || echo '   <- differs')"
    [ "${want:-0}" = "${got:-0}" ] || bad=1
  done <"$WORKDIR/compare"
  return "$bad"
}

cmd_restore() {
  local root id
  root="$(source_root)"
  id="${RUN_ID:-}"
  [ -n "$id" ] || id="$(newest_good_run "$root")" || die "no good backup in $root"
  gcloud projects describe "$TO_PROJECT" >/dev/null 2>&1 || die "project $TO_PROJECT does not exist (create it with Firebase, Firestore, Storage and Authentication first; see the runbook)"
  if [ "$TO_PROJECT" = "$PROJECT_ID" ]; then
    warn "this restores INTO PRODUCTION: documents with the same id are overwritten, users re-imported."
    type_to_confirm "Restore $id into production $PROJECT_ID" "$PROJECT_ID" || die "stopped"
  else
    confirm "Restore backup $id from $root into $TO_PROJECT?" || die "stopped"
  fi
  restore_into main "$TO_PROJECT" "$root/$id"
  [ "$DRY_RUN" = "1" ] || compare_report || warn "some counts differ (see above)"
}

# ---- drill --here -----------------------------------------------------------
cmd_drill() {
  local id src m db ok=1 n want got
  id="${RUN_ID:-}"
  [ -n "$id" ] || id="$(newest_good_run "gs://$BACKUP_BUCKET/runs")" || die "no good backup yet; run: backup.sh run"
  src="gs://$BACKUP_BUCKET/runs/$id"
  m="$WORKDIR/m.json"
  manifest_of "$src" >"$m" || die "no manifest in $src"
  db="drill-$(date -u +%Y%m%d%H%M)"
  info "Restore drill in $PROJECT_ID: backup $id (default database) -> temporary database $db"
  confirm "Create database $db, import the backup, compare, delete it? (production data is not touched)" || die "stopped"
  run gcloud firestore databases create --database="$db" --location="$(jq -r '.firestore["(default)"].location' "$m")" --project "$PROJECT_ID" --format=none \
    || die "could not create database $db"
  if ! { op="$(change main POST "$(fs_db "$PROJECT_ID" "$db"):importDocuments" "{\"inputUriPrefix\":\"$src/firestore/default\"}" | jq -r '.name // empty')" \
         && { [ "$DRY_RUN" = "1" ] || wait_op main "https://firestore.googleapis.com/v1/$op" "import into $db"; }; }; then
    ok=0
  fi
  if [ "$DRY_RUN" != "1" ] && [ "$ok" = "1" ]; then
    collection_counts "$PROJECT_ID" "$db" >"$WORKDIR/got.txt" || ok=0
    jq -r '.firestore["(default)"].collections | to_entries[] | "\(.key) \(.value)"' "$m" | sort >"$WORKDIR/want.txt"
    : >"$WORKDIR/compare"
    for n in $(cut -d' ' -f1 "$WORKDIR/want.txt" "$WORKDIR/got.txt" | sort -u); do
      want="$(awk -v c="$n" '$1==c{print $2}' "$WORKDIR/want.txt")"; got="$(awk -v c="$n" '$1==c{print $2}' "$WORKDIR/got.txt")"
      printf 'firestore %s %s %s\n' "$n" "${want:-0}" "${got:-0}" >>"$WORKDIR/compare"
    done
    # Storage and Auth: the files are there and the users convert to the import format.
    for n in $(jq -r '.storage | keys[]' "$m"); do
      printf 'storage %s %s %s\n' "$n" "$(jq -r --arg b "$n" '.storage[$b].objects' "$m")" "$(object_count_as "$src/storage/$n" gcloud)" >>"$WORKDIR/compare"
    done
    if [ "$(jq -r '.auth.users // 0' "$m")" != "0" ]; then
      gcloud storage cp "$src/auth/users.json" "$src/auth/hash-config.json" "$WORKDIR/" --quiet >/dev/null 2>&1 || ok=0
      printf 'auth importable-users %s %s\n' "$(jq -r .auth.users "$m")" "$(auth_batch_body "$WORKDIR/users.json" "$WORKDIR/hash-config.json" 0 | jq '.users | length' || echo 0)" >>"$WORKDIR/compare"
      rm -f "$WORKDIR/users.json" "$WORKDIR/hash-config.json"
    fi
    compare_report || ok=0
  fi
  info "Deleting $db"
  rrun gcloud firestore databases delete --database="$db" --project "$PROJECT_ID" --quiet --format=none || warn "delete it later: backup.sh cleanup --here"
  [ "$DRY_RUN" = "1" ] && return 0
  if [ "$ok" = "1" ]; then info "DRILL PASSED: backup $id restores with every count matching."; else die "DRILL FAILED: see above."; fi
}

cleanup_here() {
  local d
  for d in $(gcloud firestore databases list --project "$PROJECT_ID" --format='value(name)' 2>/dev/null | sed 's#.*/databases/##'); do
    [[ "$d" =~ ^drill-[0-9]{12}$ ]] || continue
    confirm "Delete leftover database $d?" && rrun gcloud firestore databases delete --database="$d" --project "$PROJECT_ID" --quiet --format=none
  done
  say "  no other drill leftovers in $PROJECT_ID"
}

# ---- the drill project ------------------------------------------------------
dapi() { vapi "$1" "$2" "${3:-}" "$DRILL_PROJECT"; }

# drill_labels '<json object>' | clear: merge labels into the drill project's
# labels (or remove them all). Through the API: gcloud only has this in alpha.
drill_labels() {
  local url="https://cloudresourcemanager.googleapis.com/v3/projects/$DRILL_PROJECT" cur new
  if [ "$1" = "clear" ]; then
    new='{}'
  else
    cur="$(dapi GET "$url" 2>/dev/null | jq -c '.labels // {}')" || cur=""
    [ -n "$cur" ] || cur='{}'
    new="$(jq -c --argjson add "$1" '. + $add' <<<"$cur")"
  fi
  change vault PATCH "$url?updateMask=labels" "{\"labels\":$new}" "$DRILL_PROJECT" >/dev/null
}

ensure_drill_project() {
  local i op
  ensure_vault_project "$DRILL_PROJECT" "YourBackupAgent drill"
  rrun "${GV[@]}" services enable firebase.googleapis.com firestore.googleapis.com firebasestorage.googleapis.com \
    identitytoolkit.googleapis.com cloudkms.googleapis.com cloudscheduler.googleapis.com cloudfunctions.googleapis.com \
    run.googleapis.com firebasehosting.googleapis.com firebaserules.googleapis.com --project "$DRILL_PROJECT"
  if ! dapi GET "https://firebase.googleapis.com/v1beta1/projects/$DRILL_PROJECT" >/dev/null 2>&1; then
    op="$(change vault POST "https://firebase.googleapis.com/v1beta1/projects/$DRILL_PROJECT:addFirebase" '{}' "$DRILL_PROJECT" | jq -r '.name // empty')"
    if [ -n "$op" ] && [ "$DRY_RUN" != "1" ]; then
      for i in $(seq 1 30); do sleep 4; [ "$(dapi GET "https://firebase.googleapis.com/v1beta1/$op" | jq -r '.done // false')" = "true" ] && break; : "$i"; done
    fi
  fi
  if ! bucket_exists_as "$DRILL_PROJECT.firebasestorage.app" "${GV[@]}"; then
    ensure_default_bucket vault "$DRILL_PROJECT" || warn "could not create the default Storage bucket of $DRILL_PROJECT (turn on Storage in its Firebase console)"
  fi
  # Authentication with email/password and email links, like a real project.
  change vault POST "https://identitytoolkit.googleapis.com/v2/projects/$DRILL_PROJECT/identityPlatform:initializeAuth" '{}' "$DRILL_PROJECT" >/dev/null 2>&1 || true
  change vault PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$DRILL_PROJECT/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
    '{"signIn":{"email":{"enabled":true,"passwordRequired":false}}}' "$DRILL_PROJECT" >/dev/null || warn "could not turn on email sign-in in $DRILL_PROJECT"
}

# wipe_drill: back to empty, whatever project was drilled last.
wipe_drill() {
  local f db uids sa n=0 site rg j
  info "Wiping $DRILL_PROJECT"
  for f in $(dapi GET "https://cloudfunctions.googleapis.com/v2/projects/$DRILL_PROJECT/locations/-/functions?pageSize=500" 2>/dev/null | jq -r '.functions[]?.name'); do
    change vault DELETE "https://cloudfunctions.googleapis.com/v2/$f" "" "$DRILL_PROJECT" >/dev/null || warn "could not delete $f"
    n=$((n + 1))
  done
  if [ "$n" -gt 0 ] && [ "$DRY_RUN" != "1" ]; then
    say "  deleting $n functions (waits)"
    for f in $(seq 1 60); do
      [ "$(dapi GET "https://cloudfunctions.googleapis.com/v2/projects/$DRILL_PROJECT/locations/-/functions?pageSize=500" 2>/dev/null | jq '.functions // [] | length')" = "0" ] && break
      sleep 15; : "$f"
    done
  fi
  for rg in $REGIONS us-central1; do
    for j in $(dapi GET "https://cloudscheduler.googleapis.com/v1/projects/$DRILL_PROJECT/locations/$rg/jobs" 2>/dev/null | jq -r '.jobs[]?.name'); do
      change vault DELETE "https://cloudscheduler.googleapis.com/v1/$j" "" "$DRILL_PROJECT" >/dev/null || true
    done
  done
  for db in $(dapi GET "https://firestore.googleapis.com/v1/projects/$DRILL_PROJECT/databases" 2>/dev/null | jq -r '.databases[]?.name | split("/") | last'); do
    change vault PATCH "$(fs_db "$DRILL_PROJECT" "$db")?updateMask=deleteProtectionState" '{"deleteProtectionState":"DELETE_PROTECTION_DISABLED"}' "$DRILL_PROJECT" >/dev/null 2>&1 || true
    change vault DELETE "$(fs_db "$DRILL_PROJECT" "$db")" "" "$DRILL_PROJECT" >/dev/null || warn "could not delete database $db"
  done
  for f in $("${GV[@]}" storage buckets list --project "$DRILL_PROJECT" --format='value(name)' 2>/dev/null); do
    case "$f" in gcf-*|*cloudbuild*|*artifacts*) continue ;; esac
    "${GV[@]}" storage objects list "gs://$f/**" --limit=1 --format='value(name)' 2>/dev/null | grep -q . \
      && run "${GV[@]}" storage rm "gs://$f/**" --quiet >/dev/null
  done
  for n in $(seq 1 200); do  # 1000 users per call; the cap stops a runaway loop
    uids="$(dapi GET "https://identitytoolkit.googleapis.com/v1/projects/$DRILL_PROJECT/accounts:batchGet?maxResults=1000" 2>/dev/null | jq -c '[.users[]?.localId]')" || break
    [ "$uids" != "[]" ] && [ -n "$uids" ] || break
    change vault POST "https://identitytoolkit.googleapis.com/v1/projects/$DRILL_PROJECT/accounts:batchDelete" "{\"localIds\":$uids,\"force\":true}" "$DRILL_PROJECT" >/dev/null || break
    [ "$DRY_RUN" != "1" ] || break
  done
  for f in $("${GV[@]}" secrets list --project "$DRILL_PROJECT" --filter='labels.drill=copy' --format='value(name)' 2>/dev/null); do
    run "${GV[@]}" secrets delete "$f" --project "$DRILL_PROJECT" --quiet >/dev/null || true
  done
  for site in $(dapi GET "https://firebasehosting.googleapis.com/v1beta1/projects/$DRILL_PROJECT/sites" 2>/dev/null | jq -r '.sites[]?.name'); do
    change vault POST "https://firebasehosting.googleapis.com/v1beta1/$site/releases" '{"type":"SITE_DISABLE"}' "$DRILL_PROJECT" >/dev/null 2>&1 || true
  done
  # Take back every outside service account's owner role (GitHub deploy keys of earlier drills).
  for sa in $("${GV[@]}" projects get-iam-policy "$DRILL_PROJECT" --format=json 2>/dev/null \
      | jq -r --arg p "$DRILL_PROJECT" '.bindings[]? | select(.role == "roles/owner") | .members[] | select(startswith("serviceAccount:") and (endswith("@" + $p + ".iam.gserviceaccount.com") | not))'); do
    rrun "${GV[@]}" projects remove-iam-policy-binding "$DRILL_PROJECT" --member="$sa" --role=roles/owner --condition=None --quiet --format=none
  done
  drill_labels clear || warn "could not clear the labels of $DRILL_PROJECT"
}

# copy_drill_secrets <run manifest file> <gs://run path>: placeholders for every
# secret the backed-up project has, then the real chain secrets (from the vault
# copy) over them, so the rebuilt site can sign as production does.
copy_drill_secrets() {
  local src="$1" names s
  names="$("${GV[@]}" storage cat "$src/config/secrets-inventory.json" 2>/dev/null | jq -r '.[].name' || true)"
  info "Secrets in $DRILL_PROJECT ($(wc -w <<<"$names" | tr -d ' ') from the backup's inventory)"
  for s in $names; do
    "${GV[@]}" secrets describe "$s" --project "$DRILL_PROJECT" >/dev/null 2>&1 \
      || run "${GV[@]}" secrets create "$s" --project "$DRILL_PROJECT" --replication-policy=automatic --labels=drill=copy --quiet --format=none
    if [[ " $CHAIN_SECRETS " == *" $s "* ]] && "${GV[@]}" secrets versions access latest --secret="$PROJECT_ID--$s" --project "$VAULT_PROJECT" >/dev/null 2>&1; then
      [ "$DRY_RUN" = "1" ] && { say "  + $s: vault copy"; continue; }
      "${GV[@]}" secrets versions access latest --secret="$PROJECT_ID--$s" --project "$VAULT_PROJECT" \
        | "${GV[@]}" secrets versions add "$s" --project "$DRILL_PROJECT" --data-file=- --quiet --format=none
      say "  $s: real value from the vault"
    else
      [[ " $CHAIN_SECRETS " != *" $s "* ]] || warn "$s: no vault copy (run backup.sh vault-secrets as the production owner); using a placeholder"
      [ "$DRY_RUN" = "1" ] || printf 'drill-placeholder' | "${GV[@]}" secrets versions add "$s" --project "$DRILL_PROJECT" --data-file=- --quiet --format=none
    fi
  done
  local k
  for k in $DRILL_KMS_KEYS; do  # location/keyring/key
    "${GV[@]}" kms keyrings describe "$(cut -d/ -f2 <<<"$k")" --location "$(cut -d/ -f1 <<<"$k")" --project "$DRILL_PROJECT" >/dev/null 2>&1 \
      || run "${GV[@]}" kms keyrings create "$(cut -d/ -f2 <<<"$k")" --location "$(cut -d/ -f1 <<<"$k")" --project "$DRILL_PROJECT"
    "${GV[@]}" kms keys describe "$(cut -d/ -f3 <<<"$k")" --keyring "$(cut -d/ -f2 <<<"$k")" --location "$(cut -d/ -f1 <<<"$k")" --project "$DRILL_PROJECT" >/dev/null 2>&1 \
      || run "${GV[@]}" kms keys create "$(cut -d/ -f3 <<<"$k")" --keyring "$(cut -d/ -f2 <<<"$k")" --location "$(cut -d/ -f1 <<<"$k")" --purpose=encryption --project "$DRILL_PROJECT"
    say "  KMS key $k: a new, empty key (keys never leave their project, so data encrypted in $PROJECT_ID does not decrypt here)"
  done
}

# The drill project is shared by every project. A drill of another project
# that was not cleaned up may still be deploying from GitHub, so replacing it
# takes --replace.
# A drill that is still restoring or deploying (drill-data or drill-site
# "running", started less than 6 hours ago) is never wiped, not even by a
# drill of the same project; --replace takes over one that died.
drill_guard() {
  local labels of since mins
  labels="$("${GV[@]}" projects describe "$DRILL_PROJECT" --format=json 2>/dev/null | jq -c '.labels // {}')" || labels='{}'
  of="$(jq -r '.["drill-of"] // ""' <<<"$labels")"
  since="$(jq -r '.["drill-since"] // "0"' <<<"$labels")"
  [[ "$since" =~ ^[0-9]+$ ]] || since=0
  if jq -e '.["drill-data"] == "running" or .["drill-site"] == "running"' <<<"$labels" >/dev/null \
     && [ $(( $(date +%s) - since )) -lt 21600 ]; then
    mins=$(( ($(date +%s) - since) / 60 ))
    say "  $DRILL_PROJECT is running a drill of $of right now (started $mins min ago)"
    [ "$REPLACE" = "1" ] && { warn "taking over the running drill of $of (--replace)"; return 0; }
    die "a drill of $of is still running in $DRILL_PROJECT (started $mins min ago). Wait for it to finish; if it died, run this again with --replace."
  fi
  [ -z "$of" ] || [ "$of" = "$PROJECT_ID" ] && return 0
  say "  $DRILL_PROJECT holds a drill of $of: $(jq -r '"run \(.["drill-run"] // "-"), data \(.["drill-data"] // "-"), site \(.["drill-site"] // "-")"' <<<"$labels")"
  [ "$REPLACE" = "1" ] && { warn "replacing the drill of $of (--replace)"; return 0; }
  die "$DRILL_PROJECT is in use by a drill of $of. If its \"Rebuild drill\" workflow is done, wipe it from that project (backup.sh cleanup --drill), or run this again with --replace."
}

cmd_rebuild() {
  local root id src
  [ -n "$DRILL_PROJECT" ] || die "DRILL_PROJECT is empty in $ENV_FILE"
  root="$(source_root)"
  id="${RUN_ID:-}"
  [ -n "$id" ] || id="$(newest_good_run "$root" vault)" || die "$VAULT_ACCOUNT finds no complete backup in $root"
  src="$root/$id"
  info "Rebuild drill as $VAULT_ACCOUNT: backup $id from $src -> $DRILL_PROJECT"
  say "  Only the vault and GitHub are used; $PROJECT_ID is not read or changed."
  drill_guard
  confirm "Wipe $DRILL_PROJECT (whatever was drilled there last), restore $id into it$([ "$DATA_ONLY" = "1" ] || echo ", then deploy $REPO there")?" || die "stopped"
  ensure_drill_project
  wipe_drill
  # Claim the drill project first, so a rebuild from another project stops here.
  drill_labels "$(jq -nc --arg of "$PROJECT_ID" --arg t "$(date +%s)" '{"drill-of": $of, "drill-data": "running", "drill-since": $t}')" || warn "could not label $DRILL_PROJECT as in use"
  restore_into vault "$DRILL_PROJECT" "$src"
  [ "$DRY_RUN" = "1" ] && { say "Dry run: nothing was restored."; return 0; }
  info "Restored copy against the backup's own counts"
  if compare_report; then
    drill_labels "$(jq -nc --arg of "$PROJECT_ID" --arg run "$(tr 'A-Z' 'a-z' <<<"$id")" '{"drill-of": $of, "drill-run": $run, "drill-data": "passed"}')" \
      || die "the data restore passed, but the drill-data=passed label on $DRILL_PROJECT could not be set (the site workflow checks it)"
    say "  DATA RESTORE PASSED"
  else
    drill_labels "$(jq -nc --arg of "$PROJECT_ID" '{"drill-of": $of, "drill-data": "failed"}')" || true
    die "DATA RESTORE FAILED: counts differ (above). $DRILL_PROJECT is kept for a look."
  fi
  copy_drill_secrets "$src"
  [ "$DATA_ONLY" = "0" ] && [ -n "$REPO" ] || { say "  Data-only drill done. Wipe it: backup.sh cleanup --drill"; return 0; }
  # A project without a site workflow gets a data-only drill, not a failure.
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 \
     && ! gh api "repos/$REPO/contents/.github/workflows/$DRILL_WORKFLOW" --silent >/dev/null 2>&1; then
    say "  $REPO has no .github/workflows/$DRILL_WORKFLOW, so the site part is skipped: data-only drill done."
    say "  Add one from the kit's templates/rebuild-drill.yml to prove the site too. Wipe this drill: backup.sh cleanup --drill"
    return 0
  fi
  [ -n "$CI_SA" ] || die "CI_SA is empty in $ENV_FILE (the GitHub deploy service account)"
  info "Site deploy (GitHub Actions, about 30-90 minutes)"
  rrun "${GV[@]}" projects add-iam-policy-binding "$DRILL_PROJECT" --member="serviceAccount:$CI_SA" --role=roles/owner --condition=None --quiet --format=none
  # The workflow sets drill-site to passed or failed when it ends.
  drill_labels "$(jq -nc --arg t "$(date +%s)" '{"drill-site": "running", "drill-since": $t}')" || warn "could not mark the site deploy as running"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    run gh workflow run "$DRILL_WORKFLOW" --repo "$REPO" --ref main -f project="$DRILL_PROJECT" -f run="$id" \
      || die "could not start the workflow; start it by hand: Actions -> Rebuild drill -> project $DRILL_PROJECT, run $id"
    say "  Started \"Rebuild drill\" in $REPO."
  else
    say "  Start it: https://github.com/$REPO/actions/workflows/$DRILL_WORKFLOW -> Run workflow (project $DRILL_PROJECT, run $id)"
  fi
  say "  Watch:  https://github.com/$REPO/actions/workflows/$DRILL_WORKFLOW"
  say "  Then open https://$DRILL_PROJECT.web.app, and wipe it: backup-kit/backup.sh cleanup --drill"
}

cmd_cleanup() {
  [ "$HERE" = "1" ] && { cleanup_here; return; }
  confirm "Wipe $DRILL_PROJECT (functions, data, files, users, secrets) and remove GitHub's access to it?" || die "stopped"
  wipe_drill
  say "  $DRILL_PROJECT is empty and ready for the next drill."
}

# ---- archive / retire -------------------------------------------------------
cmd_archive() {
  [ -n "$ARCHIVE_BUCKET" ] || die "ARCHIVE_BUCKET is empty in $ENV_FILE"
  check_vault_login
  local dst me loc a b
  info "Archiving $PROJECT_ID: one full backup kept for good in gs://$ARCHIVE_BUCKET/archive/$PROJECT_ID/"
  confirm "Take a full backup of $PROJECT_ID now and copy it to the archive?" || die "stopped"
  ensure_backup_bucket
  ensure_vault_project "$VAULT_PROJECT" "YourBackupAgent vault"
  loc="$(multi_region_for "$(db_location)")"
  vault_bucket "$ARCHIVE_BUCKET" "$loc" ARCHIVE 0
  add_lien "$VAULT_PROJECT" "YourBackupAgent vault: off-site backups and archives" "${GV[@]}"
  TRIGGER=archive
  do_run || die "the archive backup failed; nothing was archived"
  [ "$DRY_RUN" = "1" ] && return 0
  dst="gs://$ARCHIVE_BUCKET/archive/$PROJECT_ID/$RUN_ID"
  # The vault owner copies, so it needs to read this one bucket.
  me="user:$VAULT_ACCOUNT"
  rrun gcloud storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" --member="$me" --role=roles/storage.objectViewer --quiet --format=none
  rrun gcloud storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" --member="$me" --role=roles/storage.legacyBucketReader --quiet --format=none
  info "Copying to $dst (as $VAULT_ACCOUNT)"
  local n
  for n in 1 2 3 4 5 6; do
    "${GV[@]}" storage ls "$RUN_PATH/manifest.json" >/dev/null 2>&1 && break
    [ "$n" = "6" ] && die "$VAULT_ACCOUNT still cannot read gs://$BACKUP_BUCKET (permissions take a few minutes); run archive again later"
    sleep 30
  done
  rqrun "${GV[@]}" storage rsync -r "$RUN_PATH" "$dst" --exclude='manifest\.json$' --quiet
  if git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    info "Code: git bundle of every branch"
    git -C "$REPO_DIR" fetch --all --quiet 2>/dev/null || warn "could not fetch; bundling the local branches only"
    git -C "$REPO_DIR" bundle create "$WORKDIR/repo.bundle" --all >/dev/null 2>&1 && run "${GV[@]}" storage cp "$WORKDIR/repo.bundle" "$dst/code/repo.bundle" --quiet \
      || warn "could not bundle the repository"
  fi
  run "${GV[@]}" storage cp "$RUN_PATH/manifest.json" "$dst/manifest.json" --quiet
  a="$(object_count_as "$RUN_PATH" gcloud)"; b="$(object_count_as "$dst" "${GV[@]}")"
  say "  files: backup $a, archive $b (plus the code bundle)"
  [ "$b" -ge "$a" ] || die "the archive copy is missing files"
  info "ARCHIVED: $dst"
  say "  Prove it before retiring:  backup-kit/backup.sh rebuild --from archive --run $RUN_ID"
  say "  Then:                      backup-kit/backup.sh retire"
}

cmd_retire() {
  local root id labels
  [ -n "$ARCHIVE_BUCKET" ] || die "ARCHIVE_BUCKET is empty in $ENV_FILE"
  vtoken >/dev/null
  root="gs://$ARCHIVE_BUCKET/archive/$PROJECT_ID"
  id="$(newest_good_run "$root" vault)" || die "no archive of $PROJECT_ID in $root. Run: backup-kit/backup.sh archive"
  labels="$("${GV[@]}" projects describe "$DRILL_PROJECT" --format=json 2>/dev/null | jq -c '.labels // {}')"
  info "Retiring $PROJECT_ID"
  say "  archive: $root/$id"
  say "  last drill: $(jq -r '"of \(.["drill-of"] // "-"), run \(.["drill-run"] // "-"), data \(.["drill-data"] // "-"), site \(.["drill-site"] // "-")"' <<<"$labels")"
  if [ "$(jq -r '.["drill-of"] // ""' <<<"$labels")" != "$PROJECT_ID" ] || [ "$(jq -r '.["drill-run"] // ""' <<<"$labels")" != "$(tr 'A-Z' 'a-z' <<<"$id")" ] \
     || [ "$(jq -r '.["drill-data"] // ""' <<<"$labels")" != "passed" ]; then
    die "the newest archive ($id) has not passed a rebuild drill. Run: backup-kit/backup.sh rebuild --from archive --run $id"
  fi
  [ "$(jq -r '.["drill-site"] // ""' <<<"$labels")" = "passed" ] || warn "the site part of the drill did not pass (or was not run); only the data is proven"
  say "  Next: remove the deletion lien(s) and delete $PROJECT_ID. Google keeps a deleted project"
  say "  restorable for 30 days (gcloud projects undelete $PROJECT_ID), then it is gone for good."
  type_to_confirm "Delete project $PROJECT_ID" "$PROJECT_ID" || die "stopped"
  local lien
  for lien in $(gcloud alpha resource-manager liens list --project "$PROJECT_ID" --format='value(name)' 2>/dev/null); do
    run gcloud alpha resource-manager liens delete "$lien" --quiet
  done
  run gcloud projects delete "$PROJECT_ID" --quiet
  say "  Also: archive the repository (gh repo archive $REPO), remove its GitHub secrets, and"
  say "  remove the project's DNS records. The archive stays in $root for good."
}

# ---- main -------------------------------------------------------------------
# Tests source this file for its functions only.
if [ "${BACKUP_KIT_FUNCTIONS_ONLY:-}" = "1" ]; then return 0 2>/dev/null || exit 0; fi
preflight
case "$CMD" in
  vault-secrets) cmd_vault_secrets ;;
  *) "cmd_$CMD" ;;
esac
