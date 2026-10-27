#!/usr/bin/env bash
# shellcheck disable=SC2034  # variables are read inside check's eval strings
# Offline test of onboard.sh ("Set it up here"): the real kit against the
# kit's fake Google Cloud (test/fake_cloud.py) and a fake gh. Checks every
# step runs as the right sign-in, the pull request gets CI_SA and a keyless
# workflow, the first backup lands, and a second run changes nothing new.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/gcs/demo-app-backups" "$T/gcs/demo-vault-offsite" "$T/gcs/demo-app.firebasestorage.app/p" "$T/gh"
for tool in gcloud curl; do
  printf '#!/bin/sh\nexec python3 "%s" "%s" "$@"\n' "$ROOT/test/fake_cloud.py" "$tool" >"$T/bin/$tool"
done
echo img >"$T/gcs/demo-app.firebasestorage.app/p/a.webp"
# Fake gh: contents of the pull request branch live in $T/gh/<path>.
cat >"$T/bin/gh" <<'H'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE_T/gh.log"
[ "$1" = api ] || exit 1
if [ "$2" = -X ] && [ "$3" = PUT ]; then
  p="${4#repos/me/site/contents/}"; mkdir -p "$FAKE_T/gh/$(dirname "$p")"
  jq -r .content | base64 -d >"$FAKE_T/gh/$p"; echo '{}'; exit 0
fi
p="${2#repos/me/site/contents/}"; p="${p%%\?*}"
[ -f "$FAKE_T/gh/$p" ] || exit 1
case "$*" in
  *".sha"*) sha1sum "$FAKE_T/gh/$p" | cut -c1-40 ;;
  *".content"*) base64 -w0 "$FAKE_T/gh/$p" ;;
esac
H
chmod +x "$T/bin/"*
mkdir -p "$T/gh/.github/workflows" "$T/gh/backup-kit"
sed 's/DEPLOY_KEY_SECRET_NAME/YOURBACKUPAGENT_SA_KEY/' "$ROOT/templates/backup.yml" >"$T/gh/.github/workflows/backup.yml"
# The site part of rebuild drills, as the app makes it before set-up (deploy key sign-in).
(cd "$ROOT/app/functions" && node -e '
  import("./lib/drill.js").then((m) => process.stdout.write(m.drillWorkflow({ projectId: "demo-app", label: "Demo",
    facts: m.siteFacts(JSON.stringify({ hosting: { public: "dist" }, functions: { source: "functions" }, firestore: {} }), { packages: { ".": { scripts: { build: "vite build" } } } }),
    signIn: m.signIn("", "YOURBACKUPAGENT_SA_KEY") })));') >"$T/gh/.github/workflows/rebuild-drill.yml"
cat >"$T/backup.env" <<'E'
PROJECT_ID=demo-app
REPO=me/site
CI_SA=
BACKUP_BUCKET=demo-app-backups
VAULT_ACCOUNT=vault@example.com
VAULT_PROJECT=demo-vault
OFFSITE_BUCKET=demo-vault-offsite
DRILL_PROJECT=demo-drill
RUN_TIMEOUT_MIN=1
RETRIES=1
E
printf 'ya29.owner' >"$T/owner.tok"; printf 'ya29.vault' >"$T/vault.tok"
chmod 600 "$T/"*.tok
export PATH="$T/bin:$PATH" FAKE_GCS="$T/gcs" FAKE_PROJECT=demo-app FAKE_T="$T" TMPDIR="$T" CI=1 FAKE_NO_CI_SA=1
go() {
  BACKUP_ENV="$T/backup.env" KIT="$ROOT/kit/backup.sh" REPO=me/site BRANCH=yourbackupagent/protect \
    ACCESS_TOKEN_FILE="$T/owner.tok" ACCESS_EMAIL=owner@example.com VAULT_ACCESS_TOKEN_FILE="$T/vault.tok" \
    RUNNER_SA=runner@app.iam.gserviceaccount.com GH_TOKEN=ghs_x bash "$HERE/onboard.sh" >"$T/out" 2>&1
}
fail=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; tail -n 30 "$T/out"; fail=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
C="$T/calls.log"

go; rc=$?
check "a first setup succeeds and says to merge" '[ $rc = 0 ] && grep -q "^SET UP: demo-app" "$T/out"'
order="$(grep -o '^==> [1-7]/7' "$T/out" | tr '\n' ' ')"
check "all seven steps run in order" '[ "$order" = "==> 1/7 ==> 2/7 ==> 3/7 ==> 4/7 ==> 5/7 ==> 6/7 ==> 7/7 " ]'
check "the backup service account and a GitHub provider for me/site main are made" 'grep -q "service-accounts create yourbackupagent-ci --project demo-app" "$C" && grep "create-oidc" "$C" | grep -q "assertion.repository==.me/site. && assertion.ref==.refs/heads/main."'
check "CI_SA is committed to the pull request" 'grep -qx "CI_SA=yourbackupagent-ci@demo-app.iam.gserviceaccount.com" "$T/gh/backup-kit/backup.env"'
W="$T/gh/.github/workflows/backup.yml"
check "the workflow signs in with Workload Identity, no stored key" '! grep -q credentials_json "$W" && grep -q "workload_identity_provider: projects/123456/locations/global/workloadIdentityPools/yourbackupagent/providers/github" "$W" && grep -q "service_account: yourbackupagent-ci@demo-app.iam.gserviceaccount.com" "$W"'
check "the workflow may ask GitHub for its sign-in token" '[ "$(sed -n "/^permissions:/,/^[^ ]/p" "$W" | grep -c "id-token: write")" = 1 ]'
D="$T/gh/.github/workflows/rebuild-drill.yml"
check "the site drill workflow signs in with Workload Identity too" '! grep -q credentials_json "$D" && grep -q "workload_identity_provider: projects/123456/locations/global/workloadIdentityPools/yourbackupagent/providers/github" "$D" && [ "$(sed -n "/^permissions:/,/^[^ ]/p" "$D" | grep -c "id-token: write")" = 1 ]'
check "the app runner may read and prune the backup bucket (as the owner)" 'grep -q "storage buckets add-iam-policy-binding gs://demo-app-backups --member=serviceAccount:runner@app.iam.gserviceaccount.com --role=roles/storage.objectAdmin" "$T/tokenfile.log"'
check "the vault grants are made as the vault sign-in" 'grep -q -- "--access-token-file=$T/vault.tok storage buckets add-iam-policy-binding gs://demo-vault-offsite --member=serviceAccount:runner@app.iam.gserviceaccount.com --role=roles/storage.objectViewer" "$C" && grep -q -- "--access-token-file=$T/vault.tok projects add-iam-policy-binding demo-drill --member=serviceAccount:runner@app.iam.gserviceaccount.com --role=roles/owner" "$C"'
check "the project owner may copy the first backup off-site" 'grep -q -- "--access-token-file=$T/vault.tok storage buckets add-iam-policy-binding gs://demo-vault-offsite --member=user:owner@example.com --role=roles/storage.objectCreator" "$C"'
check "the first backup is in the bucket and off-site" '[ -n "$(ls "$T/gcs/demo-app-backups/runs" 2>/dev/null)" ] && [ -n "$(ls "$T/gcs/demo-vault-offsite/runs" 2>/dev/null)" ]'
check "no token in the output" '! grep -q ya29 "$T/out"'

: >"$T/gh.log"
go; rc=$?
check "a second setup succeeds and leaves the workflow as it is" '[ $rc = 0 ] && grep -q "already signs in with Workload Identity" "$T/out" && ! grep -q "contents/.github/workflows/backup.yml --input" "$T/gh.log"'
check "a second setup keeps one id-token line" '[ "$(grep -c "id-token: write" "$W")" = 1 ]'
check "a second setup leaves the site drill workflow as it is" '! grep -q "contents/.github/workflows/rebuild-drill.yml --input" "$T/gh.log" && [ "$(grep -c "id-token: write" "$D")" = 1 ]'

printf '' >"$T/owner.tok"
go; rc=$?
check "an empty owner sign-in stops at the first step" '[ $rc != 0 ] && ! grep -q "==> 3/7" "$T/out"'
exit "$fail"
