# YourBackupAgent Manager

A web app for every project protected with YourBackupAgent: health,
backup sets, restores, deletes (never below the minimum), drills, a log of
every action, reports, and "protect a repository". It lives in its own Firebase
project, `yourbackupagent-app` (https://yourbackupagent-app.web.app), owned by
dagan.gilat@gmail.com. Plan with mockups: https://claude.ai/artifact/9TFSVbWkZYs4vZhZcbxDk9

## How it works

| Part | Where | What |
|---|---|---|
| Web app | `src/` (React, Firebase Hosting) | Pages: Overview, a project's sets, Log, Reports, Settings, Protect. Reads Firestore; changes go through the API. |
| API | `functions/` (Cloud Functions, Node 22) | Runs as the runner account. Reads each project's `backup-kit/backup.env` from GitHub, lists sets in its backup bucket and the vault, deletes sets, starts GitHub workflows and the runner job, opens pull requests. Refreshes every night at 05:30 UTC. |
| Runner job | `runner/` (Cloud Run job `kit-runner`) | Runs the project's pinned `kit/backup.sh` for rebuild drills and drill-project wipes, and writes the result to the log. |
| Data | Firestore | `projects/{id}` (+ `sets/{runId}`), `log/{id}`, `drill/slot`, `config/settings`, `config/access`. Rules: people on `config/access` read; nobody writes from the browser. |

The rules for keeping sets are the kit's (`functions/lib/sets.js`, the same as
`backup.sh prune`/`delete`): the newest `KEEP_MIN_SETS` good sets of a project
are never deleted. Each project keeps that number in its own `backup.env`;
changing it in Settings opens a pull request there.

### What the app may do

| | Project's backup bucket | Vault copies | Drill project | Production data |
|---|---|---|---|---|
| Runner account (API + job) | read, delete sets (above the minimum) | read only | owner (wipe, restore, hand to GitHub) | never |
| You, signed in | through the API | delete, with your own Google sign-in (asks Google once per delete) | through the API | restore = a command the app shows you |

Backups themselves keep running in each project's GitHub Actions; the app
starts them ("Back up now", "Restore drill") through the project's `backup.yml`.
Every change is logged before it starts and updated when it ends; GitHub runs
(nightly backups, Sunday drills, drill deploys) are added on each refresh.

## Setup (once, on a Mac, as dagan.gilat@gmail.com)

```bash
cd ~/yourbackupagent                     # a checkout of this repository
app/setup.sh create                      # project, Firebase, Firestore, runner account
# Firebase console -> Authentication -> Sign-in method -> Google -> Enable
app/setup.sh token                       # GitHub token the app uses (pasted, never shown)
app/setup.sh runner                      # build + deploy the kit runner job
app/setup.sh email                       # Resend key for alerts (or: email --from PROJECT_ID)
app/setup.sh deploy                      # web app, API, rules
cd ~/foundation-next && ~/yourbackupagent/app/setup.sh grant foundation-next-app
```

New projects after that: Protect a repository in the app, then
`./onboard.sh owner/repo` from this checkout (it runs `grant` itself).

## Invite only, and email alerts

Signed out, the app shows its front page. Signing in with a Google account
that is not on the access list leads to "Ask for access": the owners get an
email and approve or decline in Settings, which also invites by address.
Email goes through Resend from `backups@plantagoai.com` (`MAIL_FROM`): a
project that needs attention or recovers (checked after the nightly refresh),
drill results as soon as a drill ends, and a Monday summary. Settings picks
which and who; "Send me a test" sends the summary to you.

Then open https://yourbackupagent-app.web.app, sign in, and press Refresh now.

## Tests

```bash
cd app && npm ci && (cd functions && npm ci)
npm run build && npm test                # typecheck, build, unit tests
runner/test.sh                           # runner entry point against a fake metadata server
node e2e/run.mjs                         # end to end: emulators + fake GitHub + a real browser
```

`e2e/run.mjs` drives the built app through sign-in, refresh, the minimum-sets
refusal, deleting project and vault copies, a rebuild drill, back up now, the
log, reports, protect a repository, the minimum pull request, phone width and
a refused stranger, and saves screenshots to `e2e/screens/`. It proves the
app's own logic. Google permissions, the real GitHub API and the runner job in
Cloud Run are proven only by the first real run.
