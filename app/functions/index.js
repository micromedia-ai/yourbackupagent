// YourBackupAgent Manager: the API behind the web app.
//
// Runs as the runner service account (RUNNER_SA). It can read every protected
// project's backup bucket and delete sets there (never below the project's
// KEEP_MIN_SETS), read the vault but not delete from it, and start the kit
// runner job (kit/backup.sh in Cloud Run) for rebuild drills. Production data
// is never written. Every call that changes something writes a log line
// first and its result after; clients can only read the log.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { github } from './lib/github.js';
import { listSets, deleteSet, drillLabels, runJob } from './lib/cloud.js';
import { parseEnv, projectSettings, setEnvValue } from './lib/env.js';
import { canDelete, health, prunePlan, RUN_ID } from './lib/sets.js';
import { firebaseProject, pickDeploySecret, kitFiles, setupCommands, TEMPLATE_PATHS, KIT_REPO } from './lib/protect.js';

initializeApp();
const db = getFirestore();

const GITHUB_TOKEN = defineSecret('GITHUB_TOKEN');
const RUNNER_SA = defineString('RUNNER_SA');
const OWNER_EMAILS = defineString('OWNER_EMAILS', { default: 'dagan.gilat@gmail.com' });
const REGION = 'us-central1';
const JOB = 'kit-runner';
const BACKUP_WORKFLOW = 'backup.yml';
const DEFAULT_REPOS = ['dagangilat/foundation-next'];

const opts = { region: REGION, secrets: [GITHUB_TOKEN], serviceAccount: RUNNER_SA, timeoutSeconds: 540, memory: '512MiB' };

// ---- access ----------------------------------------------------------------
async function allowedEmails() {
  const doc = await db.doc('config/access').get();
  const listed = (doc.exists && doc.data().emails) || [];
  return new Set([...OWNER_EMAILS.value().split(/[\s,]+/), ...listed].filter(Boolean).map((e) => e.toLowerCase()));
}

async function requireUser(req) {
  const t = req.auth && req.auth.token;
  if (!t || !t.email || !t.email_verified) throw new HttpsError('unauthenticated', 'Sign in with Google first.');
  if (!(await allowedEmails()).has(t.email.toLowerCase())) throw new HttpsError('permission-denied', `${t.email} is not on the access list.`);
  return t.email;
}

// ---- log -------------------------------------------------------------------
async function logStart(by, action, fields = {}) {
  const ref = db.collection('log').doc();
  await ref.set({ at: FieldValue.serverTimestamp(), by, action, status: 'started', ...fields });
  return ref;
}
async function logEnd(ref, status, detail, extra = {}) {
  await ref.update({ status, detail: String(detail || '').slice(0, 2000), endedAt: FieldValue.serverTimestamp(), ...extra });
}

// ---- projects ----------------------------------------------------------------
async function settings() {
  const doc = await db.doc('config/settings').get();
  const s = doc.exists ? doc.data() : {};
  return { repos: s.repos || DEFAULT_REPOS, defaultMinSets: s.defaultMinSets || 7, ...s };
}

async function loadProject(gh, repo) {
  const f = await gh.fileText(repo, 'backup-kit/backup.env');
  if (!f) return { repo, protected: false };
  const env = parseEnv(f.text);
  return { repo, protected: true, envText: f.text, ...projectSettings(env), repo: env.REPO || repo };
}

function projectRef(projectId) {
  return db.collection('projects').doc(projectId);
}

async function knownSets(projectId) {
  const snap = await projectRef(projectId).collection('sets').get();
  return snap.docs.map((d) => d.data());
}

// Fresh sets of one project: project bucket + vault, merged by id.
async function readSets(p, known) {
  const kp = new Map(known.filter((s) => s.inProject).map((s) => [s.id, s.project]).filter(([, v]) => v));
  const kv = new Map(known.filter((s) => s.inVault).map((s) => [s.id, s.vault]).filter(([, v]) => v));
  const errors = [];
  const inProject = await listSets(p.backupBucket, kp).catch((e) => { errors.push(`gs://${p.backupBucket}: ${e.message}`); return null; });
  const inVault = p.offsiteBucket
    ? await listSets(p.offsiteBucket, kv).catch((e) => { errors.push(`gs://${p.offsiteBucket}: ${e.message}`); return null; })
    : [];
  return { inProject, inVault, errors };
}

function mergeSets(inProject, inVault) {
  const by = new Map();
  for (const s of inProject || []) by.set(s.id, { id: s.id, inProject: true, inVault: false, project: s });
  for (const s of inVault || []) {
    const m = by.get(s.id) || { id: s.id, inProject: false, project: null };
    m.inVault = true;
    m.vault = s;
    by.set(s.id, m);
  }
  return [...by.values()].map((m) => {
    const main = m.project || m.vault;
    return { ...m, vault: m.vault || null, status: main.status, startedAt: main.startedAt || null, docs: main.docs ?? null, files: main.files ?? null, users: main.users ?? null, bytes: (m.project ? m.project.bytes : 0) + (m.vault ? m.vault.bytes : 0), durationSec: main.durationSec ?? null };
  });
}

async function refreshProject(gh, repo) {
  const p = await loadProject(gh, repo);
  if (!p.protected) return { repo, protected: false };
  const ref = projectRef(p.projectId);
  const known = await knownSets(p.projectId);
  const { inProject, inVault, errors } = await readSets(p, known);
  const sets = mergeSets(inProject || known.filter((s) => s.inProject).map((s) => s.project), inVault || []);
  const batch = db.batch();
  const ids = new Set(sets.map((s) => s.id));
  for (const s of sets) batch.set(ref.collection('sets').doc(s.id), s);
  if (inProject && inVault) for (const k of known) if (!ids.has(k.id)) batch.delete(ref.collection('sets').doc(k.id));
  const projectSetsOnly = (inProject || []);
  const h = inProject ? health(projectSetsOnly, { maxAgeHours: p.maxAgeHours, offsite: Boolean(p.offsiteBucket) }) : { level: 'bad', text: 'Cannot read the backup bucket' };
  const { envText, ...rest } = p;
  batch.set(ref, {
    ...rest, envText, health: h, errors, refreshedAt: FieldValue.serverTimestamp(),
    totals: { sets: sets.length, inProject: projectSetsOnly.length, inVault: (inVault || []).length, bytes: sets.reduce((a, s) => a + s.bytes, 0) },
    prunePreview: inProject ? prunePlan(projectSetsOnly, { keepMin: p.keepMinSets, keepDays: p.keepDays }) : [],
  }, { merge: false });
  await batch.commit();
  await importRuns(gh, p).catch((e) => errors.push(`GitHub runs: ${e.message}`));
  return { repo, projectId: p.projectId, protected: true, health: h, errors };
}

// GitHub runs (nightly backups, Sunday drills, rebuild drills) into the log,
// once each (doc id gh-<run id>), so the log covers what ran without the app.
async function importRuns(gh, p) {
  for (const wf of [BACKUP_WORKFLOW, p.drillWorkflow]) {
    const runs = await gh.runs(p.repo, wf, 15);
    const batch = db.batch();
    for (const r of runs) {
      const status = r.status !== 'completed' ? 'started' : r.conclusion === 'success' ? 'succeeded' : r.conclusion === 'cancelled' ? 'cancelled' : 'failed';
      batch.set(db.collection('log').doc(`gh-${r.id}`), {
        at: new Date(r.run_started_at || r.created_at), by: r.event === 'schedule' ? 'schedule' : (r.triggering_actor && r.triggering_actor.login) || 'github',
        action: wf === BACKUP_WORKFLOW ? (r.event === 'schedule' ? 'nightly backup' : 'backup workflow') : 'rebuild drill deploy',
        project: p.projectId, status, link: r.html_url, source: 'github', detail: `${r.name} #${r.run_number} (${r.event})`,
      }, { merge: true });
    }
    await batch.commit();
  }
}

async function refreshDrillSlot(drillProject) {
  if (!drillProject) return;
  const labels = await drillLabels(drillProject).catch((e) => ({ error: e.message }));
  await db.doc('drill/slot').set({ project: drillProject, labels, refreshedAt: FieldValue.serverTimestamp() });
}

async function refreshAll(token) {
  const gh = github(token);
  const s = await settings();
  const out = [];
  for (const repo of s.repos) out.push(await refreshProject(gh, repo).catch((e) => ({ repo, error: e.message })));
  const drill = out.find((o) => o.protected);
  if (drill) {
    const p = (await projectRef(drill.projectId).get()).data();
    await refreshDrillSlot(p && p.drillProject);
  }
  return out;
}

// ---- callables ---------------------------------------------------------------
// Called after sign-in: the first owner sign-in creates the access list the
// database rules read.
export const hello = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const ref = db.doc('config/access');
  const cur = await ref.get();
  if (!cur.exists) {
    await ref.set({ emails: [...await allowedEmails()] });
    await db.collection('log').add({ at: FieldValue.serverTimestamp(), by, action: 'create access list', status: 'succeeded' });
  }
  return { email: by };
});

export const refresh = onCall(opts, async (req) => {
  await requireUser(req);
  return { results: await refreshAll(GITHUB_TOKEN.value()) };
});

export const nightly = onSchedule({ ...opts, schedule: '30 5 * * *', timeZone: 'UTC' }, async () => {
  const results = await refreshAll(GITHUB_TOKEN.value());
  const bad = results.filter((r) => r.error || (r.health && r.health.level === 'bad'));
  if (bad.length) console.error(`YourBackupAgent: ${bad.length} project(s) need attention: ${bad.map((b) => b.projectId || b.repo).join(', ')}`);
});

async function projectDoc(projectId) {
  const d = await projectRef(String(projectId || '')).get();
  if (!d.exists) throw new HttpsError('not-found', `Unknown project ${projectId}. Refresh first.`);
  return d.data();
}

function checkIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((i) => RUN_ID.test(i))) {
    throw new HttpsError('invalid-argument', 'runIds must be 1-100 backup ids like 20261024T020000Z');
  }
}

export const act = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const { action, project, runIds = [], replace = false } = req.data || {};
  const p = await projectDoc(project);
  const gh = github(GITHUB_TOKEN.value());
  switch (action) {
    case 'backup':
    case 'drill-here': {
      const ref = await logStart(by, action === 'backup' ? 'back up now' : 'restore drill (temporary database)', { project: p.projectId });
      try {
        await gh.dispatch(p.repo, BACKUP_WORKFLOW, 'main', { action: action === 'backup' ? 'run' : 'drill' });
        const link = `https://github.com/${p.repo}/actions/workflows/${BACKUP_WORKFLOW}`;
        await logEnd(ref, 'dispatched', 'GitHub Backup workflow started; its run appears in the log when it finishes', { link });
        return { ok: true, link };
      } catch (e) {
        await logEnd(ref, 'failed', e.message);
        throw new HttpsError('internal', e.message);
      }
    }
    case 'delete':
    case 'prune': {
      const known = await knownSets(p.projectId);
      const fresh = await listSets(p.backupBucket, new Map(known.filter((s) => s.project).map((s) => [s.id, s.project])));
      const ids = action === 'prune' ? prunePlan(fresh, { keepMin: p.keepMinSets, keepDays: p.keepDays }).map((x) => x.id) : runIds;
      if (action === 'delete') checkIds(ids);
      if (ids.length === 0) return { ok: true, deleted: [] };
      const verdict = canDelete(fresh, ids, p.keepMinSets);
      const ref = await logStart(by, action === 'prune' ? 'prune old sets' : 'delete sets', { project: p.projectId, runIds: ids, where: `gs://${p.backupBucket}` });
      if (!verdict.ok) {
        await logEnd(ref, 'refused', verdict.reason);
        throw new HttpsError('failed-precondition', verdict.reason);
      }
      const done = [];
      try {
        for (const id of ids) { await deleteSet(p.backupBucket, id); done.push(id); }
        await logEnd(ref, 'succeeded', `deleted ${done.length} set(s) from gs://${p.backupBucket}; recoverable for 30 days (soft delete)`);
      } catch (e) {
        await logEnd(ref, 'failed', `deleted ${done.length} of ${ids.length}: ${e.message}`);
        throw new HttpsError('internal', e.message);
      }
      await refreshProject(gh, p.repo).catch(() => {});
      return { ok: true, deleted: done };
    }
    case 'rebuild':
    case 'cleanup-drill': {
      if (action === 'rebuild') checkIds(runIds.slice(0, 1));
      const slot = (await db.doc('drill/slot').get()).data() || {};
      const holder = slot.labels && slot.labels['drill-of'];
      if (action === 'rebuild' && holder && holder !== p.projectId && !replace) {
        throw new HttpsError('failed-precondition', `The drill project holds a drill of ${holder}. Wipe it first, or choose to replace it.`);
      }
      const args = action === 'rebuild'
        ? ['rebuild', '--run', runIds[0], '--yes', ...(replace ? ['--replace'] : [])]
        : ['cleanup', '--drill', '--yes'];
      const ref = await logStart(by, action === 'rebuild' ? 'rebuild drill' : 'wipe drill project', { project: p.projectId, runIds: action === 'rebuild' ? [runIds[0]] : [], where: p.drillProject });
      try {
        const execution = await runJob({
          project: process.env.GCLOUD_PROJECT, region: REGION, job: JOB, args,
          env: { BACKUP_ENV_B64: Buffer.from(p.envText).toString('base64'), LOG_DOC: ref.path, KIT_REF: p.kitRef || 'v1' },
        });
        await ref.update({ status: 'running', execution: execution || null });
        return { ok: true, log: ref.id };
      } catch (e) {
        await logEnd(ref, 'failed', e.message);
        throw new HttpsError('internal', e.message);
      }
    }
    default:
      throw new HttpsError('invalid-argument', `unknown action ${action}`);
  }
});

// Vault copies are deleted in the browser with Dagan's own Google sign-in
// (this service account cannot delete there). The page logs before and after.
export const logVault = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const { project, runIds, phase, logId, result, detail } = req.data || {};
  const p = await projectDoc(project);
  checkIds(runIds);
  if (phase === 'start') {
    const ref = await logStart(by, 'delete vault copies', { project: p.projectId, runIds, where: `gs://${p.offsiteBucket}` });
    return { logId: ref.id };
  }
  const ref = db.collection('log').doc(String(logId || ''));
  const cur = await ref.get();
  if (!cur.exists || cur.data().by !== by || cur.data().status !== 'started') throw new HttpsError('failed-precondition', 'no such started log line');
  await logEnd(ref, result === 'succeeded' ? 'succeeded' : 'failed', detail);
  await refreshProject(github(GITHUB_TOKEN.value()), p.repo).catch(() => {});
  return { ok: true };
});

// Repositories that could be protected: have firebase.json, no backup-kit yet.
export const repos = onCall(opts, async (req) => {
  await requireUser(req);
  const gh = github(GITHUB_TOKEN.value());
  const s = await settings();
  const all = (await gh.repos()).filter((r) => !r.archived && r.full_name !== KIT_REPO);
  const out = [];
  for (const r of all.slice(0, 60)) {
    const [fb, kit] = await Promise.all([gh.fileText(r.full_name, 'firebase.json'), gh.fileText(r.full_name, 'backup-kit/backup.env')]);
    if (!fb) continue;
    const rc = await gh.fileText(r.full_name, '.firebaserc');
    out.push({ repo: r.full_name, private: r.private, pushedAt: r.pushed_at, firebaseProject: rc ? firebaseProject(rc.text) : '', hasKit: Boolean(kit), managed: s.repos.includes(r.full_name) });
  }
  return { repos: out };
});

export const protect = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const { repo, label, projectId: givenId } = req.data || {};
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new HttpsError('invalid-argument', 'repo must be owner/name');
  const gh = github(GITHUB_TOKEN.value());
  const s = await settings();
  const ref = await logStart(by, 'protect repository', { repo });
  try {
    const rc = await gh.fileText(repo, '.firebaserc');
    const projectId = givenId || (rc ? firebaseProject(rc.text) : '');
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error(`no Firebase project id found in ${repo}/.firebaserc; type it in`);
    const existing = await gh.fileText(repo, 'backup-kit/backup.env');
    const [wrapper, env, workflow] = await Promise.all(Object.values(TEMPLATE_PATHS).map((pth) => gh.fileText(KIT_REPO, pth)));
    const tags = await gh.call('GET', `/repos/${KIT_REPO}/tags?per_page=50`);
    const kitRef = pickNewestTag(tags.map((t) => t.name)) || 'v1';
    const secret = pickDeploySecret(await gh.secretNames(repo).catch(() => []));
    let files = kitFiles({ repo, projectId, label: label || projectId, secret, kitRef, templates: { wrapper: wrapper.text, env: setEnvValue(env.text, 'KEEP_MIN_SETS', String(s.defaultMinSets)), workflow: workflow.text } });
    if (existing) files = files.filter((f) => f.path !== 'backup-kit/backup.env');
    const pr = await gh.pullRequest(repo, {
      branch: 'yourbackupagent/protect', message: `Back up ${projectId} with YourBackupAgent ${kitRef}`,
      title: `Backups with YourBackupAgent (${projectId})`,
      body: protectBody(projectId, kitRef, secret, existing),
      files,
    });
    if (!s.repos.includes(repo)) await db.doc('config/settings').set({ repos: [...s.repos, repo] }, { merge: true });
    await logEnd(ref, 'succeeded', `pull request #${pr.number}`, { link: pr.html_url, project: projectId });
    return { pr: pr.html_url, number: pr.number, projectId, secret, commands: setupCommands(projectId) };
  } catch (e) {
    await logEnd(ref, 'failed', e.message);
    throw new HttpsError('internal', e.message);
  }
});

// Minimum number of good sets for one project: a pull request changing
// KEEP_MIN_SETS in its backup.env (the kit reads it there every night).
export const setMinSets = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const { project, n } = req.data || {};
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new HttpsError('invalid-argument', 'n must be 1-999');
  const p = await projectDoc(project);
  const ref = await logStart(by, `set minimum sets to ${n}`, { project: p.projectId });
  try {
    const gh = github(GITHUB_TOKEN.value());
    const cur = await gh.fileText(p.repo, 'backup-kit/backup.env');
    const pr = await gh.pullRequest(p.repo, {
      branch: 'yourbackupagent/keep-min-sets', message: `Backups: keep at least ${n} good sets`,
      title: `Backups: keep at least ${n} good sets`,
      body: `Sets \`KEEP_MIN_SETS=${n}\` in \`backup-kit/backup.env\`. The newest ${n} good backup sets of ${p.projectId} are then never deleted, by the nightly prune or by the manager app.\n\nOpened from the YourBackupAgent Manager by ${by}.`,
      files: [{ path: 'backup-kit/backup.env', content: setEnvValue(cur.text, 'KEEP_MIN_SETS', String(n)) }],
    });
    await logEnd(ref, 'succeeded', `pull request #${pr.number} (takes effect when merged)`, { link: pr.html_url });
    return { pr: pr.html_url };
  } catch (e) {
    await logEnd(ref, 'failed', e.message);
    throw new HttpsError('internal', e.message);
  }
});

export const saveSettings = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const { emails, defaultMinSets, repos: repoList } = req.data || {};
  const patch = {};
  if (defaultMinSets !== undefined) {
    if (!Number.isInteger(defaultMinSets) || defaultMinSets < 1 || defaultMinSets > 999) throw new HttpsError('invalid-argument', 'minimum must be 1-999');
    patch.defaultMinSets = defaultMinSets;
  }
  if (repoList !== undefined) {
    if (!Array.isArray(repoList) || !repoList.every((r) => /^[\w.-]+\/[\w.-]+$/.test(r))) throw new HttpsError('invalid-argument', 'repos must be owner/name');
    patch.repos = [...new Set(repoList)];
  }
  const ref = await logStart(by, 'change settings', { detail: Object.keys(patch).concat(emails ? ['access list'] : []).join(', ') });
  if (Object.keys(patch).length) await db.doc('config/settings').set(patch, { merge: true });
  if (emails !== undefined) {
    if (!Array.isArray(emails) || !emails.every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) throw new HttpsError('invalid-argument', 'emails must be addresses');
    // Never lock yourself out.
    await db.doc('config/access').set({ emails: [...new Set([by.toLowerCase(), ...emails.map((e) => e.toLowerCase())])] });
  }
  await logEnd(ref, 'succeeded', '');
  return { ok: true };
});

export function pickNewestTag(names) {
  const v = names.filter((n) => /^v\d+(\.\d+)*$/.test(n))
    .map((n) => ({ n, k: n.slice(1).split('.').map(Number) }))
    .sort((a, b) => { for (let i = 0; i < 4; i++) { const d = (b.k[i] || 0) - (a.k[i] || 0); if (d) return d; } return 0; });
  return v.length ? v[0].n : '';
}

function protectBody(projectId, kitRef, secret, existing) {
  return [
    `Adds daily backups of Firebase project \`${projectId}\` with [YourBackupAgent](https://github.com/${KIT_REPO}) ${kitRef}:`,
    '',
    '- `backup-kit/backup.sh`: runs the kit version pinned in `backup-kit/backup.env`',
    existing ? '- `backup-kit/backup.env` already exists and is left as it is' : '- `backup-kit/backup.env`: this project\'s settings (names only, no secrets). Check `CI_SA` and the bucket names.',
    `- \`.github/workflows/backup.yml\`: back up at 02:00 UTC every day, restore drill on Sundays (deploy key secret: \`${secret || 'FIREBASE_SERVICE_ACCOUNT (not found: set the right name)'}\`)`,
    '',
    'Before merging: run the one-time setup as the project owner (the manager app lists the commands), otherwise the first nightly backup fails. A `rebuild-drill.yml` that deploys this site into the drill project is project-specific and comes separately (template: `templates/rebuild-drill.yml` in the kit).',
    '',
    'Opened from the YourBackupAgent Manager.',
  ].join('\n');
}
