#!/usr/bin/env bash
# Offline tests for kit/backup.sh: a fake gcloud and curl
# (test/fake_cloud.py) stand in for Google Cloud, with buckets as folders.
# They prove the script's own logic (manifest, counts, restore compare,
# argument checks, what each command touches); the real-cloud proof is a
# backup run plus a rebuild drill (see README.md).
#
# Usage: test/run.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
KIT="$(cd "$HERE/../kit" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/gcs"
for tool in gcloud curl; do
  printf '#!/bin/sh\nexec python3 "%s" "%s" "$@"\n' "$HERE/fake_cloud.py" "$tool" >"$T/bin/$tool"
  chmod +x "$T/bin/$tool"
done
export PATH="$T/bin:$PATH" FAKE_GCS="$T/gcs" FAKE_PROJECT=demo-app TMPDIR="$T" CI=1
cat >"$T/backup.env" <<'EOF'
PROJECT_ID=demo-app
PROJECT_LABEL="Demo"
REPO=example/demo
CI_SA=github-deploy@demo-app.iam.gserviceaccount.com
BACKUP_BUCKET=demo-app-backups
VAULT_ACCOUNT=vault@example.com
VAULT_PROJECT=demo-vault
OFFSITE_BUCKET=demo-vault-offsite
ARCHIVE_BUCKET=demo-vault-archive
DRILL_PROJECT=demo-drill
CHAIN_SECRETS="EVM_RELAYER_KEY"
DRILL_KMS_KEYS="global/foundation/user-wallets"
RUN_TIMEOUT_MIN=1
RETRIES=1
EOF
export BACKUP_ENV="$T/backup.env"
mkdir -p "$T/gcs/demo-app-backups" "$T/gcs/demo-vault-offsite" "$T/gcs/demo-app.firebasestorage.app/products" "$T/gcs/demo-drill.firebasestorage.app"
echo img1 >"$T/gcs/demo-app.firebasestorage.app/products/a.webp"
echo img2 >"$T/gcs/demo-app.firebasestorage.app/products/b.webp"

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; [ -z "${2:-}" ] || sed 's/^/     /' "$2" | tail -n 25; }
expect() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }
bk() { "$KIT/backup.sh" "$@" >"$T/out" 2>&1; }

# --- arguments ---------------------------------------------------------------
bk drill;                 expect "drill without --here is refused" '[ $? -ne 0 ] && grep -q "drill needs --here" "$T/out"' "$T/out"
bk run --run nope;        expect "a malformed backup id is refused" '[ $? -ne 0 ] && grep -q "is not a backup id" "$T/out"' "$T/out"
bk restore;               expect "restore needs --to" '[ $? -ne 0 ] && grep -q "restore needs --to" "$T/out"' "$T/out"
bk cleanup;               expect "cleanup needs --here or --drill" '[ $? -ne 0 ] && grep -q "needs --here or --drill" "$T/out"' "$T/out"
BACKUP_ENV=/nonexistent "$KIT/backup.sh" status >"$T/out" 2>&1
expect "a missing settings file is refused" '[ $? -ne 0 ] && grep -q "no settings file" "$T/out"' "$T/out"
bk --help;                expect "help prints the commands" 'grep -q "rebuild \[--from" "$T/out"' "$T/out"

# --- dry run changes nothing ---------------------------------------------------
: >"$T/calls.log"
bk run --dry-run;         expect "dry-run run exits 0" '[ $? -eq 0 ]' "$T/out"
expect "dry-run starts no export and writes nothing" '! grep -q "exportDocuments" "$T/calls.log" && [ -z "$(ls "$T/gcs/demo-app-backups")" ]' "$T/out"

# --- a real run ------------------------------------------------------------------
: >"$T/calls.log"
bk run;                   expect "run succeeds" '[ $? -eq 0 ] && grep -q "BACKUP SUCCEEDED" "$T/out"' "$T/out"
ID="$(ls "$T/gcs/demo-app-backups/runs" | head -n 1)"
M="$T/gcs/demo-app-backups/runs/$ID/manifest.json"
expect "run id looks like 20261024T020000Z" '[[ "$ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]'
expect "manifest says succeeded with every step ok" '[ "$(jq -r ".status, (.steps | [.firestore,.storage,.auth,.rtdb,.config,.offsite] | join(\",\"))" "$M" | tr "\n" " ")" = "succeeded ok,ok,ok,ok,ok,ok " ]' "$M"
expect "Firestore counts are taken at the export snapshot" '[ "$(jq -c ".firestore[\"(default)\"] | [.location, (.snapshotTime != null), .collections.users, .collections.polls]" "$M")" = "[\"nam5\",true,5,3]" ]' "$M"
expect "drill-* databases are not backed up" '! jq -e ".firestore | has(\"drill-202601010000\")" "$M" >/dev/null' "$M"
expect "export asked for a snapshot time" 'grep -q "exportDocuments" "$T/calls.log"'
expect "storage copied (2 files) and counted" '[ "$(jq -r ".storage[\"demo-app.firebasestorage.app\"].objects" "$M")" = 2 ] && [ -f "$T/gcs/demo-app-backups/runs/$ID/storage/demo-app.firebasestorage.app/products/a.webp" ]' "$M"
expect "auth: 3 users, 1 password hash, email-link user not counted as password" '[ "$(jq -c ".auth" "$M")" = "{\"users\":3,\"withPassword\":1,\"withPasswordHash\":1,\"hashConfig\":true}" ]' "$M"
expect "users.json and hash-config.json saved" '[ "$(jq length "$T/gcs/demo-app-backups/runs/$ID/auth/users.json")" = 3 ] && [ "$(jq -r .hashConfig.signerKey "$T/gcs/demo-app-backups/runs/$ID/auth/hash-config.json")" = a2V5 ]'
expect "config snapshot hides keys" '! grep -q "AIza-secret\|a2V5" "$T/gcs/demo-app-backups/runs/$ID/config/auth-config.json" && grep -q "(set, not copied)" "$T/gcs/demo-app-backups/runs/$ID/config/auth-config.json"'
expect "secret inventory has names only" '[ "$(jq -r ".[].name" "$T/gcs/demo-app-backups/runs/$ID/config/secrets-inventory.json" | tr "\n" " ")" = "RESEND_API_KEY EVM_RELAYER_KEY " ]'
expect "off-site copy is complete, manifest included" '[ -f "$T/gcs/demo-vault-offsite/runs/$ID/manifest.json" ] && [ -f "$T/gcs/demo-vault-offsite/runs/$ID/auth/users.json" ] && [ -f "$T/gcs/demo-vault-offsite/runs/$ID/storage/demo-app.firebasestorage.app/products/b.webp" ]'
expect "no temp files (password hashes) left behind" '[ -z "$(find "$T" -maxdepth 1 -name "backup-kit.*")" ]'

# --- check / status ------------------------------------------------------------------
bk check;                 expect "check passes after a good run" '[ $? -eq 0 ] && grep -q "newest good backup: $ID (0h ago)" "$T/out"' "$T/out"
bk status;                expect "status lists the run and its counts" '[ $? -eq 0 ] && grep -q "Firestore (default) (nam5, as of" "$T/out" && grep -q "3 users, 1/1 password hashes" "$T/out"' "$T/out"

# --- a failing step ---------------------------------------------------------------------
sleep 1
FAKE_FAIL='accounts:batchGet' bk run
expect "a failed step fails the run" '[ $? -ne 0 ] && grep -q "BACKUP FAILED" "$T/out"' "$T/out"
# shellcheck disable=SC2034 # used inside the expect strings
ID2="$(ls "$T/gcs/demo-app-backups/runs" | sort | tail -n 1)"
expect "the failed run's manifest records it and is not copied off-site" '[ "$(jq -r ".status, .steps.auth" "$T/gcs/demo-app-backups/runs/$ID2/manifest.json" | tr "\n" " ")" = "failed failed " ] && [ ! -d "$T/gcs/demo-vault-offsite/runs/$ID2" ]'
bk check;                 expect "check fails when the newest run failed" '[ $? -ne 0 ] && grep -q "::error::The newest backup run failed" "$T/out"' "$T/out"

# --- import format ------------------------------------------------------------------------
(
  export BACKUP_KIT_FUNCTIONS_ONLY=1
  # shellcheck disable=SC1091
  . "$KIT/backup.sh" status
  auth_batch_body "$T/gcs/demo-app-backups/runs/$ID/auth/users.json" "$T/gcs/demo-app-backups/runs/$ID/auth/hash-config.json" 0
) >"$T/body.json" 2>"$T/out"
expect "batchCreate body keeps hashes, claims, providers and drops output-only fields" \
  '[ "$(jq -c "[.hashAlgorithm, .signerKey, .rounds, .users[0].passwordHash, .users[0].salt, .users[0].customAttributes, (.users[0] | has(\"validSince\") or has(\"lastRefreshAt\") or has(\"passwordUpdatedAt\")), (.users[0].providerUserInfo | length), .users[1].providerUserInfo[0], (.users[2] | has(\"emailLinkSignin\"))]" "$T/body.json")" = "[\"SCRYPT\",\"a2V5\",8,\"aGFzaA==\",\"c2FsdA==\",\"{\\\"admin\\\":true}\",false,0,{\"providerId\":\"google.com\",\"rawId\":\"1234\",\"email\":\"b@example.com\",\"displayName\":\"B\"},false]" ]' "$T/body.json"

# --- drill --here ------------------------------------------------------------------------
: >"$T/calls.log"
bk drill --here --run "$ID"; expect "drill --here passes and deletes its database" '[ $? -eq 0 ] && grep -q "DRILL PASSED" "$T/out" && grep -q "firestore databases delete --database=drill-" "$T/calls.log"' "$T/out"
expect "drill --here never imports into (default)" '! grep -q "(default):importDocuments" "$T/calls.log"'

# --- rebuild (data only) ---------------------------------------------------------------------
: >"$T/calls.log"
bk rebuild --data-only;   expect "rebuild restores the newest off-site run and passes" '[ $? -eq 0 ] && grep -q "DATA RESTORE PASSED" "$T/out" && grep -q "Restoring $ID from gs://demo-vault-offsite/runs/$ID into demo-drill" "$T/out"' "$T/out"
expect "rebuild never reads or changes production" '! grep -E "projects/demo-app/|--project[= ]demo-app( |$)|gs://demo-app" "$T/calls.log" | grep -q .' "$T/calls.log"
expect "rebuild wiped the drill and took old CI owners away" 'grep -q "remove-iam-policy-binding demo-drill --member=serviceAccount:old-ci@other.iam.gserviceaccount.com" "$T/calls.log"'
expect "users imported with the hash key" '[ "$(jq -c "[.hashAlgorithm, (.users | length)]" "$T/batchCreate.json")" = "[\"SCRYPT\",3]" ]'
expect "media restored into the drill's default bucket" '[ -f "$T/gcs/demo-drill.firebasestorage.app/products/a.webp" ]'
expect "placeholder secrets from the inventory, KMS key created" 'grep -q "secrets create RESEND_API_KEY --project demo-drill" "$T/calls.log" && grep -q "kms keys create user-wallets" "$T/calls.log"'

# --- archive / retire guard ---------------------------------------------------------------------
FAKE_LABELS='{"drill-of":"demo-app","drill-run":"x","drill-data":"passed"}' bk retire --yes
expect "retire refuses without a drill of the newest archive" '[ $? -ne 0 ] && grep -q -E "no archive of demo-app|has not passed a rebuild drill" "$T/out"' "$T/out"

# --- the project wrapper ----------------------------------------------------------------------
mkdir -p "$T/proj/backup-kit"
cp "$HERE/../templates/backup-kit-wrapper.sh" "$T/proj/backup-kit/backup.sh"
{ cat "$T/backup.env"; echo "KIT_REF=v9"; } >"$T/proj/backup-kit/backup.env"
(cd "$T/proj" && env -u BACKUP_ENV YOURBACKUPAGENT_DIR="$HERE/.." backup-kit/backup.sh check) >"$T/out" 2>&1
expect "the wrapper runs the kit with the project's backup.env" 'grep -q "Backups of demo-app" "$T/out"' "$T/out"
(cd "$T/proj" && env -u BACKUP_ENV YOURBACKUPAGENT_DIR="$HERE/.." backup-kit/backup.sh --help) >"$T/out" 2>&1
expect "the wrapper passes arguments through" 'grep -q "Settings: $T/proj/backup-kit/backup.env" "$T/out"' "$T/out"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
