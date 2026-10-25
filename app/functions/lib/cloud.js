// Google Cloud calls the app's runner service account makes: read backup
// sets in each project's backup bucket and the vault, delete a set from a
// project's bucket, read the drill project's labels, start the kit runner job.
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { summarize, RUN_ID } from './sets.js';

const storage = new Storage();
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

// FAKE_GOOGLE_API: only for the offline end-to-end test (a fake Resource
// Manager and Cloud Run at that address, no Google sign-in).
async function api(method, url, body) {
  if (process.env.FAKE_GOOGLE_API) {
    const res = await fetch(url.replace(/^https:\/\/[^/]+/, process.env.FAKE_GOOGLE_API), {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw Object.assign(new Error(`${method} ${url}: ${res.status}`), { status: res.status });
    return res.json();
  }
  const client = await auth.getClient();
  const res = await client.request({ method, url, data: body, validateStatus: () => true });
  if (res.status >= 400) {
    const msg = res.data && res.data.error ? res.data.error.message : String(res.status);
    const err = new Error(`${method} ${url.split('?')[0]}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return res.data;
}

// listSets(bucket, known) -> [summary]. known: Map id -> earlier summary;
// a finished set whose size has not changed is not read again.
export async function listSets(bucket, known = new Map()) {
  const [files] = await storage.bucket(bucket).getFiles({ prefix: 'runs/', autoPaginate: true });
  const runs = new Map();
  for (const f of files) {
    const m = f.name.match(/^runs\/([0-9]{8}T[0-9]{6}Z)\/(.+)$/);
    if (!m || !RUN_ID.test(m[1])) continue;
    const r = runs.get(m[1]) || { bytes: 0, objects: 0, hasManifest: false };
    r.bytes += Number(f.metadata.size || 0);
    r.objects += 1;
    if (m[2] === 'manifest.json') r.hasManifest = true;
    runs.set(m[1], r);
  }
  const out = [];
  for (const [id, listing] of runs) {
    const old = known.get(id);
    if (old && old.bytes === listing.bytes && (old.status === 'succeeded' || old.status === 'failed')) {
      out.push(old);
      continue;
    }
    let manifest = null;
    if (listing.hasManifest) {
      try {
        const [buf] = await storage.bucket(bucket).file(`runs/${id}/manifest.json`).download();
        manifest = JSON.parse(buf.toString('utf8'));
      } catch {
        manifest = null; // summarize() marks it unknown: never deleted
      }
    }
    out.push(summarize(id, manifest, listing));
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

// storeBytes(bucket): size of the shared file store (files/) that sets in
// changed-files mode (STORAGE_MODE=changed) refer to.
export async function storeBytes(bucket) {
  const [files] = await storage.bucket(bucket).getFiles({ prefix: 'files/', autoPaginate: true });
  return files.reduce((a, f) => a + Number(f.metadata.size || 0), 0);
}

export async function deleteSet(bucket, id) {
  if (!RUN_ID.test(id)) throw new Error(`not a backup id: ${id}`);
  await storage.bucket(bucket).deleteFiles({ prefix: `runs/${id}/`, force: true });
}

// The drill project's labels (set by backup.sh rebuild): who holds it.
export async function drillLabels(project) {
  const p = await api('GET', `https://cloudresourcemanager.googleapis.com/v3/projects/${project}`);
  return p.labels || {};
}

// Start one execution of the kit runner job with these args and env.
export async function runJob({ project, region, job, args, env }) {
  const url = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/${job}:run`;
  const op = await api('POST', url, {
    overrides: { containerOverrides: [{ args, env: Object.entries(env).map(([name, value]) => ({ name, value: String(value) })) }] },
  });
  return op && op.metadata ? op.metadata.name : op && op.name;
}

export function jobRunning(execution) {
  return api('GET', `https://run.googleapis.com/v2/${execution}`).then((e) => !e.completionTime).catch(() => false);
}
