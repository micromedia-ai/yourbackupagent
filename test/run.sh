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
trap '[ -n "${KEEP_T:-}" ] || rm -rf "$T"' EXIT
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
expect "the log lists no file names, only counts" '! grep -q "^Copying " "$T/out" && grep -q "  2 files" "$T/out"' "$T/out"
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

# --- rebuild refuses another project's drill --------------------------------------------------
: >"$T/calls.log"
FAKE_LABELS='{"drill-of":"other-app","drill-data":"passed"}' bk rebuild --data-only --yes
expect "rebuild refuses while another project's drill is there" '[ $? -ne 0 ] && grep -q "in use by a drill of other-app" "$T/out" && ! grep -q "importDocuments" "$T/calls.log"' "$T/out"
NOW_S="$(date +%s)"
FAKE_LABELS="{\"drill-of\":\"demo-app\",\"drill-data\":\"running\",\"drill-since\":\"$NOW_S\"}" bk rebuild --data-only --yes
expect "rebuild refuses while a drill of the same project is still running" '[ $? -ne 0 ] && grep -q "is still running" "$T/out" && ! grep -q "importDocuments" "$T/calls.log"' "$T/out"
FAKE_LABELS="{\"drill-of\":\"demo-app\",\"drill-data\":\"passed\",\"drill-site\":\"running\",\"drill-since\":\"$NOW_S\"}" bk rebuild --data-only --yes
expect "and while its site deploy is still running" '[ $? -ne 0 ] && grep -q "is still running" "$T/out"' "$T/out"
FAKE_LABELS="{\"drill-of\":\"demo-app\",\"drill-data\":\"running\",\"drill-since\":\"$((NOW_S - 30000))\"}" bk rebuild --data-only --yes
expect "a running label older than 6 hours is a dead drill and does not block" '[ $? -eq 0 ] && grep -q "DATA RESTORE PASSED" "$T/out"' "$T/out"
FAKE_LABELS='{"drill-of":"other-app","drill-data":"passed"}' bk rebuild --data-only --yes --replace
expect "--replace takes it over" '[ $? -eq 0 ] && grep -q "DATA RESTORE PASSED" "$T/out"' "$T/out"

# --- offsite on an existing vault bucket -------------------------------------------------------
: >"$T/calls.log"
bk offsite --yes;         expect "offsite accepts the vault's own existing bucket and grants add + read" '[ $? -eq 0 ] && grep -q "storage buckets describe gs://demo-vault-offsite --raw" "$T/calls.log" && grep -q "add-iam-policy-binding gs://demo-vault-offsite .*objectCreator" "$T/calls.log"' "$T/out"
expect "offsite lets the drill project's Firestore read the vault bucket" 'grep -q "add-iam-policy-binding gs://demo-vault-offsite --member=serviceAccount:service-123456@gcp-sa-firestore.iam.gserviceaccount.com --role=roles/storage.legacyBucketReader" "$T/calls.log"' "$T/calls.log"

# --- rebuild (data only) ---------------------------------------------------------------------
: >"$T/calls.log"
bk rebuild --data-only;   expect "rebuild restores the newest off-site run and passes" '[ $? -eq 0 ] && grep -q "DATA RESTORE PASSED" "$T/out" && grep -q "Restoring $ID from gs://demo-vault-offsite/runs/$ID into demo-drill" "$T/out"' "$T/out"
expect "the wipe clears the last drill's Auth blocking functions" 'grep -q "blockingFunctions" "$T/calls.log"' "$T/out"
expect "rebuild labels the drill project as passed through the API" '[ "$(tail -n 1 "$T/labels.log" | jq -r "[.\"drill-of\", .\"drill-data\", .\"drill-run\"] | join(\",\")")" = "demo-app,passed,$(tr A-Z a-z <<<"$ID")" ]' "$T/labels.log"
expect "rebuild never reads or changes production" '! grep -E "projects/demo-app/|--project[= ]demo-app( |$)|gs://demo-app" "$T/calls.log" | grep -q .' "$T/calls.log"
expect "rebuild wiped the drill and took old CI owners away" 'grep -q "remove-iam-policy-binding demo-drill --member=serviceAccount:old-ci@other.iam.gserviceaccount.com" "$T/calls.log"'
expect "users imported with the hash key" '[ "$(jq -c "[.hashAlgorithm, (.users | length)]" "$T/batchCreate.json")" = "[\"SCRYPT\",3]" ]'
expect "media restored into the drill's default bucket" '[ -f "$T/gcs/demo-drill.firebasestorage.app/products/a.webp" ]'
expect "placeholder secrets from the inventory, KMS key created" 'grep -q "secrets create RESEND_API_KEY --project demo-drill" "$T/calls.log" && grep -q "kms keys create user-wallets" "$T/calls.log"'

# --- prune / delete: the newest KEEP_MIN_SETS good sets are always kept --------------------------
R="$T/gcs/demo-app-backups/runs"
mkset() { mkdir -p "$R/$1/firestore"; echo x >"$R/$1/firestore/data"; [ -z "$2" ] || printf '%s' "$2" >"$R/$1/manifest.json"; }
for d in 01 02 03 04 05; do mkset "202001${d}T020000Z" '{"status":"succeeded"}'; done
mkset 20200106T020000Z '{"status":"failed"}'
mkset 20200107T020000Z ''
mkset 20200108T020000Z 'not json'
left() { ls "$R" | tr '\n' ' '; }
KEEP_MIN_SETS=3 bk prune --dry-run
expect "prune --dry-run lists sets and deletes nothing" '[ $? -eq 0 ] && grep -q "delete 20200101T020000Z succeeded older than 14 days" "$T/out" && [ -d "$R/20200101T020000Z" ]' "$T/out"
KEEP_MIN_SETS=3 bk prune --yes
expect "prune keeps the newest 3 good sets, the recent failed one and the unreadable one" \
  '[ $? -eq 0 ] && [ "$(left)" = "20200104T020000Z 20200105T020000Z 20200108T020000Z $ID $ID2 " ]' "$T/out"
KEEP_MIN_SETS=3 bk delete --run 20200104T020000Z --yes
expect "delete refuses a good set when only the minimum is left" '[ $? -ne 0 ] && grep -q "at least 3 are always kept" "$T/out" && [ -d "$R/20200104T020000Z" ]' "$T/out"
KEEP_MIN_SETS=2 bk delete --run 20200104T020000Z --yes
expect "delete removes a good set above the minimum" '[ $? -eq 0 ] && [ ! -d "$R/20200104T020000Z" ]' "$T/out"
KEEP_MIN_SETS=9 bk delete --run "$ID2" --yes
expect "a failed set can always be deleted" '[ $? -eq 0 ] && [ ! -d "$R/$ID2" ]' "$T/out"
bk delete --run 20991231T000000Z --yes
expect "delete of a missing set is refused" '[ $? -ne 0 ] && grep -q "cannot read" "$T/out"' "$T/out"
bk delete --yes;          expect "delete needs --run" '[ $? -ne 0 ] && grep -q "delete needs --run" "$T/out"' "$T/out"
bk check --vault;         expect "--vault only goes with prune or delete" '[ $? -ne 0 ] && grep -q "only goes with prune or delete" "$T/out"' "$T/out"
mkdir -p "$T/gcs/demo-vault-offsite/runs/20200101T020000Z" && echo '{"status":"succeeded"}' >"$T/gcs/demo-vault-offsite/runs/20200101T020000Z/manifest.json"
: >"$T/calls.log"
KEEP_MIN_SETS=1 bk prune --vault --yes
expect "prune --vault works as the vault owner on the off-site copies" \
  '[ $? -eq 0 ] && [ ! -d "$T/gcs/demo-vault-offsite/runs/20200101T020000Z" ] && [ -d "$T/gcs/demo-vault-offsite/runs/$ID" ] && grep -q "storage rm -r gs://demo-vault-offsite/runs/20200101T020000Z" "$T/calls.log" && grep -q "gcloud --account=vault@example.com storage rm" "$T/out"' "$T/out"
sleep 1
KEEP_MIN_SETS=1 bk run --yes
expect "a good run prunes old sets after itself" '[ $? -eq 0 ] && [ ! -d "$R/20200105T020000Z" ] && [ -d "$R/20200108T020000Z" ] && [ -d "$R/$ID" ]' "$T/out"
sleep 1
mkset 20200109T020000Z '{"status":"succeeded"}'
FAKE_FAIL='accounts:batchGet' KEEP_MIN_SETS=1 bk run --yes
expect "a failed run deletes nothing" '[ $? -ne 0 ] && [ -d "$R/20200109T020000Z" ]' "$T/out"

# --- archive / retire guard ---------------------------------------------------------------------
FAKE_LABELS='{"drill-of":"demo-app","drill-run":"x","drill-data":"passed"}' bk retire --yes
expect "retire refuses without a drill of the newest archive" '[ $? -ne 0 ] && grep -q -E "no archive of demo-app|has not passed a rebuild drill" "$T/out"' "$T/out"

# --- a project without Firestore (files and users only) -------------------------------------
{ grep -v '^BACKUP_BUCKET=' "$T/backup.env"; echo "BACKUP_BUCKET=nofs-backups"; } >"$T/nofs.env"
: >"$T/calls.log"
FAKE_NO_FIRESTORE=1 BACKUP_ENV="$T/nofs.env" bk setup --yes
expect "setup without Firestore puts the backup bucket where the Storage bucket is" '[ $? -eq 0 ] && grep -q "storage buckets create gs://nofs-backups .*--location us-east1" "$T/calls.log"' "$T/out"
: >"$T/calls.log"
FAKE_NO_FIRESTORE=1 BACKUP_ENV="$T/nofs.env" bk run --yes
expect "a backup without Firestore succeeds with files and users" '[ $? -eq 0 ] && grep -q "BACKUP SUCCEEDED" "$T/out" && ! grep -q "exportDocuments" "$T/calls.log"' "$T/out"
: >"$T/calls.log"
FAKE_NO_FIRESTORE=1 BACKUP_ENV="$T/nofs.env" bk drill --here --yes
expect "drill --here without Firestore checks files and users, makes no database" '[ $? -eq 0 ] && grep -q "DRILL PASSED" "$T/out" && ! grep -q "firestore databases" "$T/calls.log"' "$T/out"
FAKE_NO_FIRESTORE=1 BACKUP_ENV="$T/nofs.env" bk status
expect "status says the project has no Firestore" '[ $? -eq 0 ] && grep -q "Firestore: none in this project" "$T/out"' "$T/out"

# --- changed-files-only storage (STORAGE_MODE=changed) ---------------------------------------
{ grep -v -E '^(BACKUP_BUCKET|OFFSITE_BUCKET)=' "$T/backup.env"; printf 'BACKUP_BUCKET=ch-backups\nOFFSITE_BUCKET=ch-vault\nSTORAGE_MODE=changed\n'; } >"$T/ch.env"
mkdir -p "$T/gcs/ch-backups" "$T/gcs/ch-vault"
SB=demo-app.firebasestorage.app; SRC="$T/gcs/$SB"; CS="$T/gcs/ch-backups/files/$SB"
chk() { BACKUP_ENV="$T/ch.env" bk "$@"; }
sleep 1; chk run --yes
# shellcheck disable=SC2034 # read inside the expect strings
C1="$(ls "$T/gcs/ch-backups/runs" | sort | tail -n 1)"
# shellcheck disable=SC2034 # read inside the expect strings
CM1="$T/gcs/ch-backups/runs/$C1/manifest.json"
expect "changed mode: the first set copies every file into the shared store" \
  '[ $? -eq 0 ] && [ "$(jq -c ".storage[\"$SB\"] | [.mode, .objects, .copiedFiles]" "$CM1")" = "[\"changed\",2,2]" ] && [ -f "$CS/o/products/a.webp" ] && [ ! -d "$T/gcs/ch-backups/runs/$C1/storage/$SB" ]' "$T/out"
expect "changed mode: the set has an index and the vault gets the store" \
  '[ "$(jq ".files | length" "$T/gcs/ch-backups/runs/$C1/storage/$SB.index.json")" = 2 ] && [ -f "$T/gcs/ch-vault/files/$SB/o/products/b.webp" ] && [ -f "$T/gcs/ch-vault/runs/$C1/storage/$SB.index.json" ]' "$T/out"
expect "changed mode: the log lists no file names" '! grep -q "products/" "$T/out"' "$T/out"
sleep 1; echo img1-edited >"$SRC/products/a.webp"; echo img3 >"$SRC/products/c.webp"
chk run --yes
# shellcheck disable=SC2034 # read inside the expect strings
C2="$(ls "$T/gcs/ch-backups/runs" | sort | tail -n 1)"
# shellcheck disable=SC2034 # read inside the expect strings
CM2="$T/gcs/ch-backups/runs/$C2/manifest.json"
expect "changed mode: the next set copies only the new and the changed file" \
  '[ $? -eq 0 ] && [ "$(jq -c ".storage[\"$SB\"] | [.objects, .copiedFiles]" "$CM2")" = "[3,2]" ] && [ "$(cat "$CS/o/products/a.webp")" = img1 ] && [ "$(cat "$CS"/v/*/products/a.webp)" = img1-edited ]' "$T/out"
expect "changed mode: the older set still points at the first copy" \
  '[ "$(jq -r ".files[] | select(.n == \"products/a.webp\") | .p" "$T/gcs/ch-backups/runs/$C1/storage/$SB.index.json")" = o/products/a.webp ]'
chk drill --here --run "$C2" --yes
expect "changed mode: drill --here finds every file of the set in the store" '[ $? -eq 0 ] && grep -q "DRILL PASSED" "$T/out"' "$T/out"
# shellcheck disable=SC2034 # read inside the expect strings
DB="$T/gcs/demo-drill.firebasestorage.app"
chk rebuild --data-only --run "$C1" --yes --replace
expect "changed mode: a rebuild of the first set restores its own versions, without later files" \
  '[ $? -eq 0 ] && grep -q "DATA RESTORE PASSED" "$T/out" && [ "$(cat "$DB/products/a.webp")" = img1 ] && [ ! -f "$DB/products/c.webp" ]' "$T/out"
chk rebuild --data-only --run "$C2" --yes --replace
expect "changed mode: a rebuild of the second set has the edited file and the new one" \
  '[ $? -eq 0 ] && grep -q "DATA RESTORE PASSED" "$T/out" && [ "$(cat "$DB/products/a.webp")" = img1-edited ] && [ -f "$DB/products/c.webp" ]' "$T/out"
# Once no set refers to a store file, it goes (after 2 days, so a running backup is safe).
rm "$SRC/products/b.webp"; sleep 1; chk run --yes
# shellcheck disable=SC2034 # read inside the expect strings
C3="$(ls "$T/gcs/ch-backups/runs" | sort | tail -n 1)"
rm -rf "$T/gcs/ch-backups/runs/$C1" "$T/gcs/ch-backups/runs/$C2"
mkdir -p "$CS/o/fresh" && echo new >"$CS/o/fresh/x.webp"
python3 -c 'import os,sys,time
for root,_,fs in os.walk(sys.argv[1]):
    for f in fs:
        p=os.path.join(root,f)
        if "fresh" not in p: os.utime(p,(time.time()-3*86400,)*2)' "$CS"
chk prune --yes
expect "changed mode: prune deletes store files no set refers to, keeps the rest" \
  '[ $? -eq 0 ] && [ ! -f "$CS/o/products/a.webp" ] && [ ! -f "$CS/o/products/b.webp" ] && [ -f "$CS/o/products/c.webp" ] && [ -f "$CS"/v/*/products/a.webp ] && [ -f "$CS/o/fresh/x.webp" ]' "$T/out"
expect "changed mode: the newest set still restores after the cleanup" \
  '[ "$(jq -r ".storage[\"$SB\"].objects" "$T/gcs/ch-backups/runs/$C3/manifest.json")" = 2 ] && chk drill --here --run "$C3" --yes && grep -q "DRILL PASSED" "$T/out"' "$T/out"
printf 'STORAGE_MODE=some\n' >>"$T/ch.env"; chk status
expect "a wrong STORAGE_MODE is refused" '[ $? -ne 0 ] && grep -q "STORAGE_MODE must be full or changed" "$T/out"' "$T/out"

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
