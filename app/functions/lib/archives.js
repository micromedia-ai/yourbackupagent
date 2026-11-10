// Archives: one full backup per retired project, kept for good in the vault's
// archive bucket(s) as archive/<project>/<run id>/ (backup.sh archive). Next to
// the backup files a folder may hold RESTORE.md (how to bring the project
// back), drill.json (the result of the rebuild drill of that archive, written
// by whoever ran it) and code/repo.bundle (git bundle of every branch).
// Pure functions, shared by the API and the tests.
import { RUN_ID, summarize } from './sets.js';

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

// groupArchives([{ name, size }]) -> Map "<project>/<id>" -> listing
export function groupArchives(files) {
  const out = new Map();
  for (const f of files) {
    const m = String(f.name).match(/^archive\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!m || !PROJECT_ID.test(m[1]) || !RUN_ID.test(m[2])) continue;
    const key = `${m[1]}/${m[2]}`;
    const a = out.get(key) || { projectId: m[1], id: m[2], bytes: 0, objects: 0, hasManifest: false, hasRestoreNote: false, hasDrill: false, hasCode: false };
    a.bytes += Number(f.size || 0);
    a.objects += 1;
    if (m[3] === 'manifest.json') a.hasManifest = true;
    else if (m[3] === 'RESTORE.md') a.hasRestoreNote = true;
    else if (m[3] === 'drill.json') a.hasDrill = true;
    else if (m[3].startsWith('code/')) a.hasCode = true;
    out.set(key, a);
  }
  return out;
}

// drill.json -> { status: passed|failed|unknown, at, site, detail }
export function drillResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = raw.status === 'passed' || raw.status === 'failed' ? raw.status : 'unknown';
  const site = raw.site === 'passed' || raw.site === 'failed' ? raw.site : 'not run';
  return { status, at: typeof raw.at === 'string' ? raw.at : null, site, detail: raw.detail ? String(raw.detail).slice(0, 300) : null };
}

// One row per archive: listing + manifest + drill. bucket: where it lives.
export function archiveRow(bucket, listing, manifest, drill) {
  const s = summarize(listing.id, manifest, listing);
  return {
    projectId: listing.projectId, id: listing.id, bucket, path: `gs://${bucket}/archive/${listing.projectId}/${listing.id}/`,
    status: s.status, startedAt: s.startedAt || null, docs: s.docs ?? null, files: s.files ?? null, users: s.users ?? null,
    bytes: listing.bytes, objects: listing.objects, commit: s.commit || null,
    hasRestoreNote: listing.hasRestoreNote, hasCode: listing.hasCode, drill: drillResult(drill),
  };
}

// The newest archive of each project; older ones are counted.
export function newestPerProject(rows) {
  const by = new Map();
  for (const r of rows) {
    const cur = by.get(r.projectId);
    if (!cur) by.set(r.projectId, { ...r, older: 0, copies: [r.bucket] });
    else if (r.id > cur.id) by.set(r.projectId, { ...r, older: cur.older + 1, copies: [...new Set([...cur.copies, r.bucket])] });
    else if (r.id === cur.id) cur.copies = [...new Set([...cur.copies, r.bucket])];
    else cur.older += 1;
  }
  return [...by.values()].sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
}
