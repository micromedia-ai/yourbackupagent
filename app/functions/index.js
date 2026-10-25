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
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import { createHash, randomBytes } from 'node:crypto';
import { github } from './lib/github.js';
import { listSets, deleteSet, drillLabels, runJob } from './lib/cloud.js';
import { parseEnv, projectSettings, setEnvValue } from './lib/env.js';
import { canDelete, health, prunePlan, RUN_ID } from './lib/sets.js';
import { lockBlocks, endsLock, LOCK_HOURS } from './lib/drilllock.js';
import { firebaseProject, pickDeploySecret, kitFiles, setupCommands, TEMPLATE_PATHS, KIT_REPO } from './lib/protect.js';
import { sendMail } from './lib/mail.js';
import { createOAuth, OAuthError, resourceMetadata, authServerMetadata, resourceUrl } from './lib/oauth.js';
import { handleMcp } from './lib/mcp.js';
import { healthEvents, levels, drillFinished, healthEmail, drillEmail, weeklyEmail, accessRequestEmail, welcomeEmail, EMAIL_RE } from './lib/alerts.js';

initializeApp();
const db = getFirestore();

const GITHUB_TOKEN = defineSecret('GITHUB_TOKEN');
const RUNNER_SA = defineString('RUNNER_SA');
const OWNER_EMAILS = defineString('OWNER_EMAILS', { default: 'dagan.gilat@gmail.com' });
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const MAIL_FROM = defineString('MAIL_FROM', { default: 'YourBackupAgent <backups@plantagoai.com>' });
const APP_URL = defineString('APP_URL', { default: 'https://yourbackupagent-app.web.app' });
const REGION = 'us-central1';
const JOB = 'kit-runner';
const BACKUP_WORKFLOW = 'backup.yml';
const DEFAULT_REPOS = ['dagangilat/foundation-next'];

const opts = { region: REGION, secrets: [GITHUB_TOKEN, RESEND_API_KEY], serviceAccount: RUNNER_SA, timeoutSeconds: 540, memory: '512MiB' };

// ---- access ----------------------------------------------------------------
async function allowedEmails() {
  const doc = await db.doc('config/access').get();
  const listed = (doc.exists && doc.data().emails) || [];
  return new Set([...OWNER_EMAILS.value().split(/[\s,]+/), ...listed].filter(Boolean).map((e) => e.toLowerCase()));
}

function signedIn(req) {
  const t = req.auth && req.auth.token;
  if (!t || !t.email || !t.email_verified) throw new HttpsError('unauthenticated', 'Sign in with Google first.');
  return t;
}

async function requireUser(req) {
  const t = signedIn(req);
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
  return { repos: s.repos || DEFAULT_REPOS, defaultMinSets: s.defaultMinSets || 7, ...s, sizeWarnSetGB: s.sizeWarnSetGB ?? 2, sizeWarnTotalGB: s.sizeWarnTotalGB ?? 20 };
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

async function refreshProject(gh, repo, s = null) {
  s = s || await settings();
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
  const totalBytes = sets.reduce((a, x) => a + x.bytes, 0);
  const h = inProject
    ? health(projectSetsOnly, { maxAgeHours: p.maxAgeHours, offsite: Boolean(p.offsiteBucket), maxSetBytes: (s.sizeWarnSetGB || 0) * 1e9, maxTotalBytes: (s.sizeWarnTotalGB || 0) * 1e9, totalBytes })
    : { level: 'bad', text: 'Cannot read the backup bucket' };
  const { envText, ...rest } = p;
  batch.set(ref, {
    ...rest, envText, health: h, errors, refreshedAt: FieldValue.serverTimestamp(),
    totals: { sets: sets.length, inProject: projectSetsOnly.length, inVault: (inVault || []).length, bytes: totalBytes },
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
  for (const repo of s.repos) out.push(await refreshProject(gh, repo, s).catch((e) => ({ repo, error: e.message })));
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
  await checkAlerts('schedule');
});

// ---- email alerts ------------------------------------------------------------
const NOTIFY_DEFAULTS = { health: true, recoveries: true, drills: true, weekly: true, recipients: null };

async function notifySettings() {
  const d = await db.doc('config/notify').get();
  const n = { ...NOTIFY_DEFAULTS, ...(d.exists ? d.data() : {}) };
  const access = [...await allowedEmails()];
  n.recipients = (n.recipients || access).filter((e) => access.includes(e));
  return n;
}

async function mail(to, msg, what, by = 'schedule') {
  const ref = await logStart(by, `email: ${what}`, {});
  try {
    const r = await sendMail({ key: RESEND_API_KEY.value(), from: MAIL_FROM.value(), to, ...msg });
    await logEnd(ref, r.skipped ? 'skipped' : 'succeeded', r.skipped || `sent to ${r.count} recipient(s): ${msg.subject}`);
    return r;
  } catch (e) {
    await logEnd(ref, 'failed', e.message);
    throw e;
  }
}

// Compares every project's health with the last check and emails changes.
async function checkAlerts(by) {
  const n = await notifySettings();
  const projects = (await db.collection('projects').get()).docs.map((d) => d.data());
  const stateRef = db.doc('notify/state');
  const prev = ((await stateRef.get()).data() || {}).levels || {};
  const events = healthEvents(prev, projects).filter((e) => (e.kind === 'alert' ? n.health : n.recoveries));
  await stateRef.set({ levels: levels(projects), checkedAt: FieldValue.serverTimestamp() }, { merge: true });
  if (events.length) await mail(n.recipients, healthEmail(events, APP_URL.value()), events.some((e) => e.kind === 'alert') ? 'backups need attention' : 'backups recovered', by);
  return events.map((e) => ({ kind: e.kind, project: e.project.projectId, level: e.level }));
}

// Drill results, as soon as a drill's log line finishes (from the runner job,
// a GitHub drill run read on refresh, or the app).
export const drillAlert = onDocumentWritten({ document: 'log/{id}', region: REGION, secrets: [RESEND_API_KEY], serviceAccount: RUNNER_SA }, async (ev) => {
  const after = ev.data.after.exists ? ev.data.after.data() : null;
  const lockRef = db.doc('drill/lock');
  if (endsLock((await lockRef.get()).data(), ev.params.id, after)) await lockRef.delete();
  const d = drillFinished(ev.data.before.exists ? ev.data.before.data() : null, ev.data.after.exists ? ev.data.after.data() : null);
  if (!d) return;
  const n = await notifySettings();
  if (!n.drills) return;
  const p = d.line.project ? (await projectRef(d.line.project).get()).data() : null;
  await mail(n.recipients, drillEmail(d, p && p.label, APP_URL.value()), `drill ${d.passed ? 'passed' : 'failed'}`, 'drill');
});

async function weeklySummary(to, by) {
  const projects = (await db.collection('projects').get()).docs.map((d) => d.data());
  const setsByProject = {};
  for (const p of projects) setsByProject[p.projectId] = await knownSets(p.projectId);
  const since = new Date(Date.now() - 7 * 86400000);
  const log = (await db.collection('log').where('at', '>=', since).get()).docs.map((d) => d.data());
  return mail(to, weeklyEmail(projects, setsByProject, log, APP_URL.value()), 'weekly summary', by);
}

export const weekly = onSchedule({ ...opts, schedule: '0 6 * * 1', timeZone: 'UTC' }, async () => {
  const n = await notifySettings();
  if (n.weekly) await weeklySummary(n.recipients, 'schedule');
});

export const saveNotify = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const { health: h, recoveries, drills, weekly: w, recipients } = req.data || {};
  const patch = {};
  for (const [k, v] of Object.entries({ health: h, recoveries, drills, weekly: w })) if (v !== undefined) patch[k] = Boolean(v);
  if (recipients !== undefined) {
    if (!Array.isArray(recipients) || !recipients.every((e) => EMAIL_RE.test(e))) throw new HttpsError('invalid-argument', 'recipients must be addresses');
    patch.recipients = recipients.map((e) => e.toLowerCase());
  }
  await db.doc('config/notify').set(patch, { merge: true });
  await db.collection('log').add({ at: FieldValue.serverTimestamp(), by, action: 'change email alerts', status: 'succeeded', detail: Object.keys(patch).join(', ') });
  return { ok: true };
});

// "Send me a test": the weekly summary, to the caller only.
export const testEmail = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const r = await weeklySummary([by], by);
  if (r.skipped) throw new HttpsError('failed-precondition', r.skipped);
  return { ok: true };
});

export const alertsNow = onCall(opts, async (req) => {
  const by = await requireUser(req);
  return { events: await checkAlerts(by) };
});

// ---- invite only ---------------------------------------------------------------
// Someone signed in but not on the list asks; the owners get an email and
// approve or decline in Settings.
export const requestAccess = onCall(opts, async (req) => {
  const t = signedIn(req);
  const email = t.email.toLowerCase();
  if ((await allowedEmails()).has(email)) return { status: 'approved' };
  const note = String((req.data && req.data.note) || '').slice(0, 300);
  const ref = db.collection('requests').doc(email);
  const cur = await ref.get();
  if (cur.exists && cur.data().status === 'pending') return { status: 'pending' };
  if (cur.exists && cur.data().status === 'declined' && Date.now() - cur.data().at.toMillis() < 86400000) return { status: 'declined' };
  await ref.set({ email, name: t.name || '', note, status: 'pending', at: FieldValue.serverTimestamp() });
  await db.collection('log').add({ at: FieldValue.serverTimestamp(), by: email, action: 'ask for access', status: 'pending' });
  await mail(OWNER_EMAILS.value().split(/[\s,]+/).filter(Boolean), accessRequestEmail(email, note, APP_URL.value()), 'access request', email).catch(() => {});
  return { status: 'pending' };
});

async function grantAccess(by, email) {
  const ref = db.doc('config/access');
  const cur = ((await ref.get()).data() || {}).emails || [];
  await ref.set({ emails: [...new Set([...cur, email])] });
}

export const decideAccess = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const { email, approve } = req.data || {};
  if (!EMAIL_RE.test(email || '')) throw new HttpsError('invalid-argument', 'email');
  const e = email.toLowerCase();
  const ref = await logStart(by, approve ? 'approve access' : 'decline access', { detail: e });
  if (approve) await grantAccess(by, e);
  await db.collection('requests').doc(e).set({ status: approve ? 'approved' : 'declined', decidedBy: by, decidedAt: FieldValue.serverTimestamp() }, { merge: true });
  await logEnd(ref, 'succeeded', e);
  if (approve) await mail([e], welcomeEmail(e, by, APP_URL.value()), 'welcome', by).catch(() => {});
  return { ok: true };
});

export const invite = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const email = String((req.data && req.data.email) || '').toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpsError('invalid-argument', 'Type a Google account address.');
  const ref = await logStart(by, 'invite', { detail: email });
  await grantAccess(by, email);
  await logEnd(ref, 'succeeded', email);
  const r = await mail([email], welcomeEmail(email, by, APP_URL.value()), 'invite', by).catch((e) => ({ skipped: e.message }));
  return { ok: true, emailed: !r.skipped };
});

async function projectDoc(projectId) {
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(String(projectId || ''))) throw new HttpsError('not-found', `Unknown project ${projectId || '(none)'}. See the overview for project ids.`);
  const d = await projectRef(projectId).get();
  if (!d.exists) throw new HttpsError('not-found', `Unknown project ${projectId}. Refresh first.`);
  return d.data();
}

function checkIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((i) => RUN_ID.test(i))) {
    throw new HttpsError('invalid-argument', 'runIds must be 1-100 backup ids like 20261024T020000Z');
  }
}

export const act = onCall(opts, async (req) => runAction(await requireUser(req), req.data || {}));

// What the Act buttons do, for the app and the MCP connector alike.
async function runAction(by, data) {
  const { action, project, runIds = [], replace = false } = data;
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
      const what = action === 'rebuild' ? 'rebuild drill' : 'wipe drill project';
      const ref = db.collection('log').doc();
      const lockRef = db.doc('drill/lock');
      // One drill at a time: a second click, or a drill of any other project,
      // waits until this one's log line ends.
      await db.runTransaction(async (tx) => {
        const busy = lockBlocks((await tx.get(lockRef)).data());
        if (busy) throw new HttpsError('failed-precondition', busy);
        tx.set(lockRef, { project: p.projectId, by, action: what, log: ref.id, at: new Date(), until: new Date(Date.now() + LOCK_HOURS * 3600000) });
      });
      await ref.set({ at: FieldValue.serverTimestamp(), by, action: what, status: 'started', project: p.projectId, runIds: action === 'rebuild' ? [runIds[0]] : [], where: p.drillProject });
      try {
        const execution = await runJob({
          project: process.env.GCLOUD_PROJECT, region: REGION, job: JOB, args,
          env: { BACKUP_ENV_B64: Buffer.from(p.envText).toString('base64'), LOG_DOC: ref.path, KIT_REF: p.kitRef || 'v1' },
        });
        await ref.update({ status: 'running', execution: execution || null });
        return { ok: true, log: ref.id };
      } catch (e) {
        await logEnd(ref, 'failed', e.message);
        await lockRef.delete().catch(() => {});
        throw new HttpsError('internal', e.message);
      }
    }
    default:
      throw new HttpsError('invalid-argument', `unknown action ${action}`);
  }
}

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

// Repositories that could be protected: have firebase.json (at the root or in
// app/) or already have the kit.
export const repos = onCall(opts, async (req) => {
  await requireUser(req);
  const gh = github(GITHUB_TOKEN.value());
  const s = await settings();
  const all = (await gh.repos()).filter((r) => !r.archived && r.full_name !== KIT_REPO);
  const out = [];
  for (const r of all.slice(0, 60)) {
    const [fb, kit] = await Promise.all([gh.fileText(r.full_name, 'firebase.json'), gh.fileText(r.full_name, 'backup-kit/backup.env')]);
    // Some repos keep the Firebase app in app/ (limorgilat.com); a repo that has the kit counts too.
    const sub = fb ? null : await gh.fileText(r.full_name, 'app/firebase.json');
    if (!fb && !sub && !kit) continue;
    const rc = (await gh.fileText(r.full_name, '.firebaserc')) || (sub ? await gh.fileText(r.full_name, 'app/.firebaserc') : null);
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
    const rc = (await gh.fileText(repo, '.firebaserc')) || (await gh.fileText(repo, 'app/.firebaserc'));
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
      body: protectBody(repo, projectId, kitRef, secret, existing),
      files,
    });
    if (!s.repos.includes(repo)) await db.doc('config/settings').set({ repos: [...s.repos, repo] }, { merge: true });
    await logEnd(ref, 'succeeded', `pull request #${pr.number}`, { link: pr.html_url, project: projectId });
    return { pr: pr.html_url, number: pr.number, projectId, secret, commands: setupCommands(repo) };
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
  const { emails, defaultMinSets, repos: repoList, sizeWarnSetGB, sizeWarnTotalGB } = req.data || {};
  const patch = {};
  for (const [k, v] of [['sizeWarnSetGB', sizeWarnSetGB], ['sizeWarnTotalGB', sizeWarnTotalGB]]) {
    if (v === undefined) continue;
    if (typeof v !== 'number' || !(v >= 0) || v > 100000) throw new HttpsError('invalid-argument', 'size watch levels are GB, 0 (off) to 100000');
    patch[k] = v;
  }
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

function protectBody(repo, projectId, kitRef, secret, existing) {
  return [
    `Adds daily backups of Firebase project \`${projectId}\` with [YourBackupAgent](https://github.com/${KIT_REPO}) ${kitRef}:`,
    '',
    '- `backup-kit/backup.sh`: runs the kit version pinned in `backup-kit/backup.env`',
    existing ? '- `backup-kit/backup.env` already exists and is left as it is' : '- `backup-kit/backup.env`: this project\'s settings (names only, no secrets). Check `CI_SA` and the bucket names.',
    `- \`.github/workflows/backup.yml\`: back up at 02:00 UTC every day, restore drill on Sundays (sign-in secret: \`${secret || 'YOURBACKUPAGENT_SA_KEY, made by onboard.sh'}\`)`,
    '',
    'Before merging: run the one-time setup on a Mac, from a checkout of dagangilat/yourbackupagent: `./onboard.sh ' + repo + '` (it logs in, makes the GitHub key if needed, sets up the buckets and protection, takes the first backup and offers a rebuild drill). Otherwise the first nightly backup fails. A `rebuild-drill.yml` that deploys this site into the drill project is project-specific and comes separately (template: `templates/rebuild-drill.yml` in the kit).',
    '',
    'Opened from the YourBackupAgent Manager.',
  ].join('\n');
}

// ---- MCP connector (lib/mcp.js, lib/oauth.js) ----------------------------------
// https://<app>/mcp for an AI assistant such as Claude, signed in with OAuth as
// someone on the access list. Its tools call the same code as the app's
// buttons, so the same rules hold and every change is logged.

async function isAllowed(email) {
  return Boolean(email) && (await allowedEmails()).has(String(email).toLowerCase());
}

// OAuth records live under the server-only mcp/oauth document.
const oauthStore = {
  async get(col, id) { const s = await db.collection(col).doc(id).get(); return s.exists ? s.data() : null; },
  async set(col, id, data) { await db.collection(col).doc(id).set(data); },
  async update(col, id, data) { await db.collection(col).doc(id).update(data); },
  async take(col, id) {
    const ref = db.collection(col).doc(id);
    return db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      tx.delete(ref);
      return s.data();
    });
  },
  async delete(col, id) { await db.collection(col).doc(id).delete(); },
  async query(col, field, value) {
    let q = db.collection(col);
    if (field) q = q.where(field, '==', value);
    return (await q.limit(500).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
  },
  async purgeExpired(col, ms) {
    const snap = await db.collection(col).where('expiresAt', '<', ms).limit(100).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  },
};

const oauth = createOAuth({ store: oauthStore, now: () => Date.now(), random: () => randomBytes(32).toString('base64url'), isAllowed });

// The address the request came in on, when it is this app's; else APP_URL.
function publicBase(req) {
  const app = new URL(APP_URL.value());
  const host = String(req.headers['x-forwarded-host'] || req.hostname || '').split(',')[0].trim().toLowerCase();
  if (host === app.host) return app.origin;
  const id = process.env.GCLOUD_PROJECT;
  if (host === `${id}.web.app` || host === `${id}.firebaseapp.com`) return `https://${host}`;
  return app.origin;
}

// At most `limit` requests per window from one address (hashed).
async function allowRate(key, limit, windowMs) {
  const ref = db.collection('mcp/rate/hits').doc(createHash('sha256').update(key).digest('hex').slice(0, 40));
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    const fresh = !cur || now - cur.start > windowMs;
    const count = fresh ? 1 : cur.count + 1;
    tx.set(ref, { start: fresh ? now : cur.start, count, expiresAt: (fresh ? now : cur.start) + windowMs });
    return count <= limit;
  });
}

function oauthReply(res, e) {
  res.set('Cache-Control', 'no-store');
  if (e instanceof OAuthError) return res.status(e.status).json({ error: e.error, ...(e.description ? { error_description: e.description } : {}) });
  console.error('[oauth] error', e?.message || String(e));
  return res.status(500).json({ error: 'server_error' });
}

function basicClient(req) {
  const m = String(req.headers.authorization || '').match(/^Basic (.+)$/i);
  if (!m) return null;
  const [id, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  return { id: decodeURIComponent(id || ''), secret: decodeURIComponent(rest.join(':')) };
}

const plainProject = (p) => ({
  projectId: p.projectId, label: p.label, repo: p.repo, kitRef: p.kitRef, health: p.health, totals: p.totals || null,
  keepMinSets: p.keepMinSets, keepDays: p.keepDays, maxAgeHours: p.maxAgeHours, backupBucket: p.backupBucket,
  offsiteBucket: p.offsiteBucket || null, drillProject: p.drillProject || null, refreshedAt: p.refreshedAt || null,
  errors: p.errors || [], wouldPrune: (p.prunePreview || []).length,
});

const mcpOps = {
  async overview() {
    const projects = (await db.collection('projects').get()).docs.map((d) => plainProject(d.data()));
    const slot = (await db.doc('drill/slot').get()).data() || null;
    const lock = (await db.doc('drill/lock').get()).data() || null;
    return {
      projects,
      drillProject: slot && { project: slot.project, holdsDrillOf: (slot.labels && slot.labels['drill-of']) || null, labels: slot.labels || {} },
      drillBusy: lockBlocks(lock),
      appUrl: APP_URL.value(),
    };
  },
  async sets(project, n) {
    const p = await projectDoc(project);
    const sets = (await knownSets(p.projectId)).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, n);
    return sets.map((s) => ({ id: s.id, status: s.status, startedAt: s.startedAt, docs: s.docs, files: s.files, users: s.users, bytes: s.bytes, durationSec: s.durationSec, inProject: s.inProject, inVault: s.inVault }));
  },
  async log(project, n) {
    let q = db.collection('log');
    if (project) q = q.where('project', '==', project);
    const snap = await q.orderBy('at', 'desc').limit(n).get();
    return snap.docs.map((d) => {
      const l = d.data();
      return { id: d.id, at: l.at, by: l.by, action: l.action, status: l.status, project: l.project || null, runIds: l.runIds || null, detail: l.detail || null, link: l.link || null };
    });
  },
  refresh: () => refreshAll(GITHUB_TOKEN.value()),
  act: runAction,
  async preview({ action, project, runIds = [] }) {
    const p = await projectDoc(project);
    if (action === 'cleanup-drill') {
      const slot = (await db.doc('drill/slot').get()).data() || {};
      return { preview: true, wouldWipe: p.drillProject, holdsDrillOf: (slot.labels && slot.labels['drill-of']) || null, busy: lockBlocks((await db.doc('drill/lock').get()).data()) };
    }
    const known = await knownSets(p.projectId);
    const fresh = await listSets(p.backupBucket, new Map(known.filter((s) => s.project).map((s) => [s.id, s.project])));
    const ids = action === 'prune' ? prunePlan(fresh, { keepMin: p.keepMinSets, keepDays: p.keepDays }).map((x) => x.id) : runIds;
    if (action === 'delete') checkIds(ids);
    const verdict = ids.length ? canDelete(fresh, ids, p.keepMinSets) : { ok: true };
    return { preview: true, project: p.projectId, where: `gs://${p.backupBucket}`, wouldDelete: ids, allowed: verdict.ok, reason: verdict.ok ? null : verdict.reason, keepMinSets: p.keepMinSets, vault: 'vault copies are not deleted here' };
  },
  async restoreCommand(project, runId) {
    const p = await projectDoc(project);
    checkIds([runId]);
    const set = (await knownSets(p.projectId)).find((s) => s.id === runId);
    if (!set) throw new HttpsError('not-found', `No set ${runId} in ${p.projectId}. See list_sets.`);
    const name = p.repo.split('/')[1];
    return {
      note: 'Run this on your computer, in a checkout of the repository. Nothing is restored from here.',
      command: [`cd ~/path/to/${name}`, 'backup-kit/backup.sh run          # a fresh backup first', `backup-kit/backup.sh restore --to ${p.projectId} --run ${runId}${set.inProject ? ` --from gs://${p.backupBucket}/runs` : ''}`].join('\n'),
    };
  },
};

const MCP_LIMIT_PER_10_MIN = 300;
const REGISTER_LIMIT_PER_HOUR = 30;

export const mcp = onRequest({ ...opts, invoker: 'public' }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id');
  res.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const path = (req.path || '/').replace(/\/+$/, '') || '/';
  const base = publicBase(req);
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (path.startsWith('/.well-known/oauth-protected-resource') || path.startsWith('/.well-known/oauth-authorization-server')) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(path.includes('protected-resource') ? resourceMetadata(base) : authServerMetadata(base));
  }
  if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'Use POST with JSON-RPC (MCP streamable HTTP).' });
  try {
    if (path === '/mcp/oauth/register') {
      if (!(await allowRate(`reg:${ip}`, REGISTER_LIMIT_PER_HOUR, 3600000))) return res.status(429).json({ error: 'too_many_requests' });
      return res.status(201).json(await oauth.register(req.body));
    }
    if (path === '/mcp/oauth/token') {
      res.set('Cache-Control', 'no-store');
      if (!(await allowRate(`tok:${ip}`, MCP_LIMIT_PER_10_MIN, 600000))) return res.status(429).json({ error: 'too_many_requests' });
      return res.json(await oauth.token(req.body, basicClient(req)));
    }
    if (path === '/mcp/oauth/revoke') {
      await oauth.revokeToken(String((req.body && req.body.token) || '')).catch(() => {});
      return res.status(200).json({});
    }
  } catch (e) {
    return oauthReply(res, e);
  }
  if (path !== '/mcp') return res.status(404).json({ error: 'Not found' });
  if (!(await allowRate(`mcp:${ip}`, MCP_LIMIT_PER_10_MIN, 600000))) {
    return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limit exceeded' } });
  }
  const token = (String(req.headers.authorization || '').match(/^Bearer (.+)$/) || [])[1] || '';
  const who = await oauth.verify(token);
  if (!who) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="backups"`);
    return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  }
  const out = await handleMcp(req.body, {
    ops: mcpOps,
    by: `${who.email} via ${String(who.clientName || 'AI assistant').slice(0, 40)}`,
    onToolCall: ({ name, ok }) => console.info('[mcp] tool', { name, ok }),
  });
  if (out === null) return res.status(202).send('');
  return res.status(200).json(out);
});

// The /connect-ai page: someone on the access list taps Allow or Cancel.
export const mcpConsent = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const b = req.data || {};
  const params = { clientId: b.client_id, redirectUri: b.redirect_uri, state: b.state, codeChallenge: b.code_challenge, codeChallengeMethod: b.code_challenge_method, resource: b.resource };
  try {
    if (b.action === 'describe') return await oauth.describe(params);
    if (b.action === 'deny') return await oauth.deny(params);
    if (b.action === 'approve') {
      const { clientName } = await oauth.describe(params);
      const out = await oauth.approve({ ...params, user: { uid: req.auth.uid, email: by } });
      await db.collection('log').add({ at: FieldValue.serverTimestamp(), by, action: 'connect AI assistant', status: 'succeeded', detail: String(clientName).slice(0, 100) });
      return out;
    }
  } catch (e) {
    if (e instanceof OAuthError) throw new HttpsError(e.status === 401 ? 'unauthenticated' : 'invalid-argument', e.description || e.error);
    throw e;
  }
  throw new HttpsError('invalid-argument', 'unknown action');
});

// Settings: connected assistants, and disconnecting one.
export const mcpGrants = onCall(opts, async (req) => {
  const by = await requireUser(req);
  const { action, id } = req.data || {};
  if (action === 'remove') {
    if (!/^g_[A-Za-z0-9_-]{10,40}$/.test(String(id || ''))) throw new HttpsError('invalid-argument', 'invalid id');
    const g = await oauthStore.get('mcp/oauth/grants', id);
    await oauth.removeGrant(id);
    await db.collection('log').add({ at: FieldValue.serverTimestamp(), by, action: 'disconnect AI assistant', status: 'succeeded', detail: g ? `${g.clientName} (${g.email})` : id });
    return { removed: id };
  }
  const iso = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
  const grants = (await oauth.listGrants()).map((g) => ({ ...g, createdAt: iso(g.createdAt), lastUsedAt: iso(g.lastUsedAt) }));
  return { grants, url: resourceUrl(new URL(APP_URL.value()).origin) };
});
