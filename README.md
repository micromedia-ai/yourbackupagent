# YourBackupAgent

Backs up a Firebase project, proves the backup restores, and archives a
project before it is retired. One script (`kit/backup.sh`) for every project;
each project keeps only its settings (`backup-kit/backup.env`), a small
wrapper, a daily workflow that uses this repository as a GitHub Action, and
its own rebuild-drill workflow. It needs no app code.

It grew out of the limorgilat.com backups (proven there with a full rebuild
drill, Oct 2026). Its lessons are built in: new projects take minutes before
their permissions work, a Firestore import needs bucket-level read on the
source bucket, a first deploy into a new project needs retries, and a backup
is only proven by restoring it somewhere else.

## This repository

| Path | What |
|---|---|
| `kit/backup.sh`, `kit/lib.sh` | The kit (bash 3.2, gcloud, jq, curl) |
| `action.yml` | GitHub Action: `uses: dagangilat/yourbackupagent@v1` with `command: run`, `check` or `drill` |
| `templates/backup.env.example` | A project's settings |
| `templates/backup-kit-wrapper.sh` | Goes to a project's `backup-kit/backup.sh`: runs the kit version pinned by `KIT_REF` |
| `templates/backup.yml` | A project's daily workflow (backup + check, Sunday restore drill) |
| `templates/rebuild-drill.yml` | Foundation Next's hand-made rebuild-drill workflow; other projects get one generated from their `firebase.json` by the manager app (`app/functions/lib/drill.js`) |
| `test/run.sh` | Offline tests against a fake Google Cloud |

Versions are tags (`v1`, `v1.1`, ...). A project moves to a new version by
changing `KIT_REF` in its backup.env and `@v1` in its workflow.

The repository is private, so projects can use the Action only with
Settings -> Actions -> General -> Access -> "Accessible from repositories
owned by the user dagangilat".

## What a backup holds

`gs://<project>-backups/runs/<id>/` (id like `20261024T020000Z`):

| Folder | What |
|---|---|
| `firestore/<database>/` | Managed export of every Firestore database, at one exact moment (point-in-time recovery makes the export and the counts read the same minute) |
| `storage/<bucket>/` | Every file of the Firebase Storage bucket(s) |
| `storage/<bucket>.index.json` | Instead of `storage/<bucket>/` when `STORAGE_MODE=changed`: every file of that night and where its copy is in the shared store |
| `auth/users.json`, `auth/hash-config.json` | Every Auth user (uid, email, providers, custom claims, password hashes) and the project's password hash key |
| `rtdb/<instance>.json` | Realtime Database contents, when there is one |
| `config/*.json` | Deployed rules, indexes, database settings, Auth settings and providers, Hosting sites and domains, web apps, functions, scheduled jobs, secret **names**, KMS key names, buckets, IAM, enabled APIs |
| `manifest.json` | Written last: status, each step, and the counts the restore is checked against |

With `STORAGE_MODE=changed`, media files are kept once in a shared store
next to the sets, `gs://<project>-backups/files/<bucket>/` (`o/<name>` is
the first copy of a file, `v/<md5>/<name>` a later different content), and
each set copies only what is new or changed since the last one. Nothing in
the store is ever overwritten, so the off-site copy still needs only
create access. Every set restores in full; `prune` (after each good run,
and `prune --vault`) deletes store files that no remaining set refers to,
once they are 2 days old. An archive always holds full copies.

A run without `manifest.json` is incomplete. `auth/` holds password hashes
together with their key: treat every backup bucket like a password database.

Not in a backup: secret values (Secret Manager), KMS keys (Google never lets
them leave their project), and anything outside Firebase (blockchains, other
services). `vault-secrets` keeps a copy of chosen secrets in the vault.

## Where copies live

| Copy | Kept | Who can delete it |
|---|---|---|
| `gs://<project>-backups` in the project | `BACKUP_KEEP_DAYS` (14), never fewer than the newest `KEEP_MIN_SETS` (7) good sets, + 30 days soft delete | project owners (GitHub prunes after each good run) |
| Google-managed Firestore backups (`protect`) | `MANAGED_KEEP_DAYS` (14) | project owners |
| Firestore point-in-time recovery (`protect`) | 7 days, any minute | project owners |
| Off-site: `gs://<OFFSITE_BUCKET>` in the vault project | `OFFSITE_KEEP_DAYS` (90) + 30 days soft delete | the vault owner only; GitHub may add and read files, never delete |
| Archive: `gs://<ARCHIVE_BUCKET>/archive/<project>/<id>/` | for good (Archive storage class) | the vault owner only |

Old sets are deleted by `backup.sh prune`, which `run` calls after every
good backup (never after a failed one): the newest `KEEP_MIN_SETS` good sets
are always kept whatever their age, other good sets go after
`BACKUP_KEEP_DAYS`, failed or incomplete sets after 3 days, and a set whose
manifest cannot be read is never deleted. `backup.sh delete --run <id>`
deletes one set, and refuses a good one when only `KEEP_MIN_SETS` are left.
`--vault` (as the vault owner) does the same for the off-site copies; there
the bucket's `OFFSITE_KEEP_DAYS` age rule stays as a backstop, because GitHub
may not delete in the vault. Before v1.1 the project bucket had an age rule
on `runs/`; run `backup.sh setup` once after moving to v1.1 to remove it.

The vault project (`VAULT_PROJECT`) and the drill project (`DRILL_PROJECT`)
are shared by every project and owned by `VAULT_ACCOUNT`, a Google account
separate from the one that owns production. The drill project is wiped at the
start of every drill; GitHub gets owner access to it only during a drill.

## Adding the kit to a project

The short way, without a terminal: in the manager app, **Protect a
repository** (it opens the pull request), then **Set it up here**: sign in
with Google as an owner of the project (and as `VAULT_ACCOUNT` when that is
another account). The app's runner then does the one-time setup with that
short-lived sign-in (`app/runner/onboard.sh`): `github-access` (GitHub signs
in to Google through Workload Identity Federation, so no key is stored
anywhere), commits `CI_SA` and the keyless sign-in to the pull request, then
setup, protect, offsite, the app's access and the first backup. The sign-in is
used once, never stored past that, and expires within the hour. Merge the pull
request, then start a rebuild drill from the project page.

The same on your own computer, from this checkout (it makes a JSON key instead):

```bash
./onboard.sh owner/repo        # login, GitHub key if missing, setup, protect, offsite,
                               # first backup, app access, rebuild drill, merge (asks first)
```

Either runs every step below in order and can run again. By hand:

1. In the project repository: `mkdir backup-kit`, copy
   `templates/backup-kit-wrapper.sh` to `backup-kit/backup.sh` (executable),
   `templates/backup.env.example` to `backup-kit/backup.env` and fill it in.
2. Copy `templates/backup.yml` to `.github/workflows/backup.yml` and set the
   deploy key secret name.
3. `.github/workflows/rebuild-drill.yml` builds and deploys the site into the
   drill project. The manager app makes one from the repo's `firebase.json`
   (in the Protect pull request, or "Add site drill" on a project's page);
   edit it when the project deploys in a special way (Foundation Next's
   batched functions deploy is in `templates/rebuild-drill.yml`).
   What a drill checks ("parts": data, web, api, service, mobile) is detected
   from the repo (`app/functions/lib/parts.js`) or set with `DRILL_PARTS` and
   `HEALTH_PATH` in `backup.env`; the api part requires every function
   production runs to be active in the drill. "Update site drill" remakes an
   app-made workflow with the current checks.
4. Run the one-time setup below as a project owner, then a rebuild drill.

## One-time setup (copy-paste)

On a Mac: `brew install --cask google-cloud-sdk && brew install jq`, then
`gcloud components install alpha beta`. Log in to both accounts once:

```bash
gcloud auth login dagan.gilat@gmail.com      # the vault owner
gcloud auth login <production owner>         # leaves this one active
cd <repository>
backup-kit/backup.sh setup                   # backup bucket + GitHub's roles (lists CI_SA candidates the first time)
backup-kit/backup.sh protect                 # PITR, delete protection, managed backups, lien
backup-kit/backup.sh offsite                 # vault project + off-site bucket (as the vault owner)
backup-kit/backup.sh vault-secrets           # only if CHAIN_SECRETS is set
backup-kit/backup.sh run                     # first backup (then GitHub runs it daily)
backup-kit/backup.sh status
```

Every command checks its inputs first and asks before each change;
`--dry-run` prints what would change.

## Proving it

- `backup.sh drill --here` (GitHub runs it every Sunday): restores the newest
  backup into a temporary database in the project, compares every count with
  the backup's manifest, deletes the database.
- `backup.sh rebuild` (by hand, after setup and after big changes): as the
  vault owner only, as if production and its owner were gone. Wipes the drill
  project, restores the newest off-site backup into it, compares every count,
  then starts the repository's "Rebuild drill" workflow, which deploys the
  site from `main` into the drill project and smoke-tests it.
  `backup.sh cleanup --drill` wipes it again when you have looked.

## Archiving an old project

```bash
backup-kit/backup.sh archive                          # full backup + git bundle -> archive bucket
backup-kit/backup.sh rebuild --from archive --run <id>   # prove that archive restores (and deploys)
backup-kit/backup.sh cleanup --drill
backup-kit/backup.sh retire                           # only after a passed drill of that archive
```

`retire` refuses unless the drill project's labels show a passed drill of the
newest archive, asks you to type the project id, removes the deletion lien and
deletes the project (Google can undelete it for 30 days).

## Tests

`test/run.sh` runs every command against a fake Google Cloud
(buckets are folders). It proves the script's own logic; only a real backup
and rebuild drill prove the cloud side.
