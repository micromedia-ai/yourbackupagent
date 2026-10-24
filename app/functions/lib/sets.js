// Backup sets: what one run folder (runs/<id>/) holds, and the rules for
// keeping and deleting sets. Pure functions, shared by the API and the tests;
// the same rules as `backup.sh prune` / `backup.sh delete` in the kit.

export const RUN_ID = /^[0-9]{8}T[0-9]{6}Z$/;
const STALE_DAYS = 3;

// "20261024T153544Z" -> Date
export function runTime(id) {
  const m = RUN_ID.test(id) && id.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

export function cutoffId(days, now = new Date()) {
  const d = new Date(now.getTime() - days * 86400000);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// summarize(id, manifest|null, {bytes, objects, hasManifest}) -> the set's
// state and counts. manifest null + hasManifest true = could not be read.
export function summarize(id, manifest, listing = {}) {
  const base = { id, bytes: listing.bytes || 0, objects: listing.objects || 0 };
  if (!manifest) {
    return { ...base, status: listing.hasManifest ? 'unknown' : 'incomplete' };
  }
  const status = manifest.status === 'succeeded' || manifest.status === 'failed' ? manifest.status : 'unknown';
  const fs = manifest.firestore || {};
  let docs = 0, collections = 0;
  for (const db of Object.values(fs)) {
    for (const n of Object.values(db.collections || {})) { docs += Number(n) || 0; collections += 1; }
  }
  const files = Object.values(manifest.storage || {}).reduce((a, b) => a + (Number(b.objects) || 0), 0);
  const started = manifest.startedAt ? Date.parse(manifest.startedAt) : null;
  const finished = manifest.finishedAt ? Date.parse(manifest.finishedAt) : null;
  return {
    ...base,
    status,
    trigger: manifest.trigger || null,
    startedAt: manifest.startedAt || null,
    finishedAt: manifest.finishedAt || null,
    durationSec: started && finished ? Math.round((finished - started) / 1000) : null,
    docs, collections, files,
    users: manifest.auth ? Number(manifest.auth.users) || 0 : null,
    steps: manifest.steps || {},
    errors: (manifest.errors || []).slice(0, 5).map((e) => String(e).slice(0, 300)),
    kitRef: manifest.kitRef || null,
    commit: manifest.commit || null,
  };
}

// prunePlan(sets, {keepMin, keepDays, now}) -> [{id, status, why}]
// The newest keepMin good sets are never listed; 'unknown' never is either.
export function prunePlan(sets, { keepMin, keepDays, now = new Date() }) {
  const old = cutoffId(keepDays, now), stale = cutoffId(STALE_DAYS, now);
  const out = [];
  let good = 0;
  for (const s of [...sets].sort((a, b) => (a.id < b.id ? 1 : -1))) {
    if (s.status === 'succeeded') {
      good += 1;
      if (good > keepMin && s.id < old) out.push({ id: s.id, status: s.status, why: `older than ${keepDays} days` });
    } else if ((s.status === 'failed' || s.status === 'incomplete') && s.id < stale) {
      out.push({ id: s.id, status: s.status, why: `${s.status}, older than ${STALE_DAYS} days` });
    }
  }
  return out;
}

// canDelete(sets, ids, keepMin) -> {ok, reason}. Deleting several at once is
// checked as a whole: good sets left afterwards must be >= keepMin.
export function canDelete(sets, ids, keepMin) {
  const want = new Set(ids);
  const byId = new Map(sets.map((s) => [s.id, s]));
  for (const id of want) {
    if (!byId.has(id)) return { ok: false, reason: `no set ${id}` };
    if (byId.get(id).status === 'unknown') return { ok: false, reason: `${id} could not be read; it is never deleted` };
  }
  const goodNow = sets.filter((s) => s.status === 'succeeded').length;
  const goodGone = [...want].filter((id) => byId.get(id).status === 'succeeded').length;
  if (goodGone > 0 && goodNow - goodGone < keepMin) {
    return { ok: false, reason: `would leave ${goodNow - goodGone} good sets; at least ${keepMin} are always kept` };
  }
  return { ok: true, goodAfter: goodNow - goodGone };
}

const gb = (n) => `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;

// health(sets, {maxAgeHours, offsite, now, maxSetBytes, maxTotalBytes, totalBytes})
//   -> {level: ok|warn|bad, text, ...}. The size limits are "watch" levels: a
//   set or the project's backups growing past them is a warning, never an error.
export function health(sets, { maxAgeHours = 26, offsite = true, now = new Date(), maxSetBytes = 0, maxTotalBytes = 0, totalBytes = 0 } = {}) {
  const sorted = [...sets].sort((a, b) => (a.id < b.id ? 1 : -1));
  const good = sorted.filter((s) => s.status === 'succeeded');
  if (good.length === 0) return { level: 'bad', text: sorted.length ? 'No good backup' : 'No backups yet', goodCount: 0 };
  const newestGood = good[0];
  const ageHours = Math.floor((now - runTime(newestGood.id)) / 3600000);
  const base = { goodCount: good.length, newestGood: newestGood.id, ageHours };
  if (ageHours > maxAgeHours) return { ...base, level: 'bad', text: `Newest good backup is ${ageHours}h old` };
  if (sorted[0].status === 'failed') return { ...base, level: 'warn', text: 'The newest run failed' };
  if (offsite && newestGood.steps && newestGood.steps.offsite !== 'ok') return { ...base, level: 'warn', text: 'Off-site copy missing' };
  const setBytes = newestGood.bytes || 0;
  if (maxSetBytes && setBytes > maxSetBytes) return { ...base, level: 'warn', text: `Newest set is ${gb(setBytes)} (watch level ${gb(maxSetBytes)})` };
  if (maxTotalBytes && totalBytes > maxTotalBytes) return { ...base, level: 'warn', text: `Backups take ${gb(totalBytes)} (watch level ${gb(maxTotalBytes)})` };
  return { ...base, level: 'ok', text: 'Healthy' };
}
