#!/usr/bin/env bash
# Bring one repository's Firebase project under YourBackupAgent in one go,
# after "Protect a repository" in the manager app opened its pull request.
#
#   ./onboard.sh OWNER/REPO [--drill | --no-drill]
#
# Run it on a Mac from this checkout of dagangilat/yourbackupagent. It:
#   1. checks out the repository's yourbackupagent/protect branch (or its
#      default branch once that is merged) under ~/.cache/yourbackupagent/repos
#   2. makes sure gcloud is logged in as the vault owner and as an owner of
#      the project (asks you to log in only when one is missing)
#   3. when the project has no GitHub key for backups yet: creates the
#      service account yourbackupagent-ci, stores its key as the repository
#      secret YOURBACKUPAGENT_SA_KEY and commits CI_SA + the secret name
#   4. backup-kit/backup.sh setup, protect, offsite, run (the first backup)
#   5. app/setup.sh grant (the manager app may read and prune the backups)
#   6. a rebuild drill into the shared drill project (asks first)
#   7. offers to merge the pull request
# Every step can run again. Prints commands, ids and counts, never secrets.
# bash 3.2 compatible.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRANCH=yourbackupagent/protect
SECRET_NAME=YOURBACKUPAGENT_SA_KEY
SA_NAME=yourbackupagent-ci

say() { printf '%s\n' "$*"; }
step() { printf '\n=== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
run() { printf '  + %s\n' "$*" >&2; "$@"; }
ask() { # ask "question" default(y|n) -> 0 for yes
  local a
  if [ ! -t 0 ]; then [ "$2" = y ]; return; fi
  printf '%s ' "$1"; read -r a || a=""
  a="${a:-$2}"
  case "$a" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}
retry() {
  local n=1
  until "$@"; do
    [ "$n" -lt 4 ] || return 1
    say "  (not ready yet, trying again in 20s)"; n=$((n + 1)); sleep 20
  done
}
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }

REPO="${1:-}"
[ "$REPO" = "-h" ] || [ "$REPO" = "--help" ] && usage 0
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
shift
DRILL=ask
while [ $# -gt 0 ]; do
  case "$1" in
    --drill) DRILL=yes ;;
    --no-drill) DRILL=no ;;
    *) usage ;;
  esac
  shift
done
for t in git gh gcloud jq; do
  command -v "$t" >/dev/null 2>&1 || die "$t is missing (brew install $t)"
done

step "Repository $REPO"
WORK="${YBA_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/yourbackupagent/repos}/${REPO#*/}"
if [ -d "$WORK/.git" ]; then
  run git -C "$WORK" fetch -q origin
else
  mkdir -p "$(dirname "$WORK")"
  run gh repo clone "$REPO" "$WORK" -- -q
fi
ON_PR=0
# Work on the protect branch only while its pull request is open: once it is
# merged, a commit pushed there would never reach the default branch.
if git -C "$WORK" rev-parse -q --verify "refs/remotes/origin/$BRANCH" >/dev/null \
  && [ "$(gh pr view "$BRANCH" --repo "$REPO" --json state -q .state 2>/dev/null)" = OPEN ]; then
  run git -C "$WORK" checkout -q -B "$BRANCH" "origin/$BRANCH"
  ON_PR=1
else
  def="$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name)"
  run git -C "$WORK" checkout -q -B "$def" "origin/$def"
fi
ENV="$WORK/backup-kit/backup.env"
WF="$WORK/.github/workflows/backup.yml"
[ -f "$ENV" ] && [ -f "$WF" ] || die "$REPO has no backup-kit yet. In the manager app: Protect a repository, then run this again."
val() { sed -n "s/^$1=//p" "$ENV" | tr -d '"' | tail -n 1; }
PROJECT_ID="$(val PROJECT_ID)"
VAULT="$(val VAULT_ACCOUNT)"
CI_SA="$(val CI_SA)"
[ -n "$PROJECT_ID" ] || die "PROJECT_ID is empty in backup-kit/backup.env"
say "  project $PROJECT_ID, checkout $WORK"

step "Google accounts"
accounts() { gcloud auth list --format='value(account)' 2>/dev/null; }
if [ -n "$VAULT" ] && ! accounts | grep -qx "$VAULT"; then
  say "  Log in as $VAULT (owns the vault and the drill project)"
  run gcloud auth login "$VAULT"
fi
is_owner() { # IAM keeps the case the owner was added with (user:Dagan.Gilat@...)
  local policy
  if ! policy="$(gcloud projects get-iam-policy "$PROJECT_ID" --account "$1" --format=json 2>&1)"; then
    say "  $1 cannot read $PROJECT_ID's permissions: $(printf '%s' "$policy" | grep -m1 ERROR || true)"
    return 1
  fi
  printf '%s' "$policy" | jq -e --arg m "user:$1" \
    '[.bindings[]? | select(.role == "roles/owner") | .members[] | ascii_downcase] | index($m | ascii_downcase)' >/dev/null
}
OWNER=""
for a in $(gcloud config get-value account 2>/dev/null) $(accounts); do
  if is_owner "$a"; then OWNER="$a"; break; fi
done
if [ -z "$OWNER" ]; then
  say "  None of your gcloud logins owns $PROJECT_ID. Log in as its owner:"
  run gcloud auth login
  a="$(gcloud config get-value account 2>/dev/null)"
  is_owner "$a" || die "$a does not own $PROJECT_ID either"
  OWNER="$a"
fi
export CLOUDSDK_CORE_ACCOUNT="$OWNER"
say "  project owner: $OWNER; vault: ${VAULT:-none}"

step "GitHub Actions key"
SECRET="$(sed -n 's/.*secrets\.\([A-Za-z0-9_]*\).*/\1/p' "$WF" | head -n 1)"
if [ -n "$CI_SA" ] && gh secret list --repo "$REPO" --json name -q '.[].name' | grep -qx "$SECRET"; then
  say "  the workflow signs in with secret $SECRET as $CI_SA"
else
  SA="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
  say "  making one: service account $SA, key stored as secret $SECRET_NAME"
  if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
    run gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" \
      --display-name="YourBackupAgent (GitHub Actions backups)"
    say "  waiting for the new account to show up in IAM"; sleep 20
  fi
  KEY="$(mktemp)"
  trap 'rm -f "$KEY"' EXIT
  retry run gcloud iam service-accounts keys create "$KEY" --iam-account "$SA" --project "$PROJECT_ID" --quiet
  run gh secret set "$SECRET_NAME" --repo "$REPO" <"$KEY"
  rm -f "$KEY"
  if grep -q '^CI_SA=' "$ENV"; then
    sed -i.bak "s/^CI_SA=.*/CI_SA=$SA/" "$ENV"
  else
    printf 'CI_SA=%s\n' "$SA" >>"$ENV"
  fi
  sed -i.bak -E "s/secrets\.[A-Za-z0-9_]+/secrets.$SECRET_NAME/" "$WF"
  rm -f "$ENV.bak" "$WF.bak"
  CI_SA="$SA"
  git -C "$WORK" add backup-kit/backup.env .github/workflows/backup.yml
  git -C "$WORK" commit -q -m "Backups: GitHub Actions signs in as $SA (secret $SECRET_NAME)"
  if [ "$ON_PR" = 1 ]; then
    run git -C "$WORK" push -q origin "HEAD:$BRANCH"
  else
    BRANCH=yourbackupagent/ci-key
    run git -C "$WORK" push -q -f origin "HEAD:refs/heads/$BRANCH"
    run gh pr create --repo "$REPO" --head "$BRANCH" --title "Backups: GitHub Actions key for YourBackupAgent" \
      --body "Sets CI_SA to $SA and the Backup workflow's secret to $SECRET_NAME (made by onboard.sh). Merge it, or the nightly backup cannot sign in."
    ON_PR=1
  fi
fi

K="$WORK/backup-kit/backup.sh"
step "Backup bucket and roles (setup)"
(cd "$WORK" && run "$K" setup)
step "Point-in-time recovery, delete protection, managed backups (protect)"
(cd "$WORK" && run "$K" protect)
if [ -n "$VAULT" ]; then
  step "Off-site bucket in the vault (offsite)"
  (cd "$WORK" && run "$K" offsite)
  # The first backup runs here as the project owner: when that is not the
  # vault owner, it may add to (and read, to copy) this project's off-site bucket.
  OFFSITE="$(val OFFSITE_BUCKET)"
  lower() { printf %s "$1" | tr '[:upper:]' '[:lower:]'; }
  if [ -n "$OFFSITE" ] && [ "$(lower "$OWNER")" != "$(lower "$VAULT")" ]; then
    for role in roles/storage.objectCreator roles/storage.objectViewer; do
      run gcloud storage buckets add-iam-policy-binding "gs://$OFFSITE" --member "user:$OWNER" \
        --role "$role" --account "$VAULT" --format=none --quiet
    done
  fi
fi
step "First backup (run)"
(cd "$WORK" && run "$K" run)

step "Let the manager app read and prune it (grant)"
(cd "$WORK" && run "${YBA_APP_SETUP:-$KIT_DIR/app/setup.sh}" grant "$PROJECT_ID")

DRILL_RESULT="skipped"
if [ "$DRILL" = yes ] || { [ "$DRILL" = ask ] && ask "Prove it with a rebuild drill now (about 20-40 min)? [Y/n]" y; }; then
  step "Rebuild drill"
  if (cd "$WORK" && run "$K" rebuild); then DRILL_RESULT="passed"; else DRILL_RESULT="FAILED"; warn "the drill failed; the output above says where"; fi
fi

step "Done: $PROJECT_ID"
say "  first backup: done; rebuild drill: $DRILL_RESULT"
if [ "$ON_PR" = 1 ]; then
  url="$(gh pr view "$BRANCH" --repo "$REPO" --json url -q .url 2>/dev/null || true)"
  say "  pull request: ${url:-$BRANCH}"
  if [ "$DRILL_RESULT" != "FAILED" ] && ask "Merge it now, so the nightly backup starts? [y/N]" n; then
    run gh pr merge "$BRANCH" --repo "$REPO" --squash --delete-branch
  else
    say "  Merge it when you're ready: the nightly backup runs from the default branch."
  fi
fi
[ "$DRILL_RESULT" != "FAILED" ]
