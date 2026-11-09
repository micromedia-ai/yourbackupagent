// Fake GitHub + Google (Resource Manager, Cloud Run) + Resend for the offline
// end-to-end test. Records every change it is asked for in `calls`.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const KIT = new URL('../../', import.meta.url);
const tpl = (p) => readFileSync(new URL(p, KIT), 'utf8');
const b64 = (s) => Buffer.from(s).toString('base64');

export const ENV = `KIT_REF=v1.1
PROJECT_ID=demo-fn
PROJECT_LABEL="Foundation Next"
REPO=dagangilat/foundation-next
CI_SA=deploy@demo-fn.iam.gserviceaccount.com
BACKUP_BUCKET=demo-fn-backups
BACKUP_KEEP_DAYS=14
KEEP_MIN_SETS=3
VAULT_ACCOUNT=dagan.gilat@gmail.com
VAULT_PROJECT=demo-vault
OFFSITE_BUCKET=demo-vault-fn
DRILL_PROJECT=demo-drill
`;

export function startFakes(port = 4999) {
  const calls = [];
  const emails = [];
  const files = {
    'dagangilat/foundation-next': { 'backup-kit/backup.env': ENV, 'firebase.json': '{"hosting":{"public":"dist","rewrites":[{"source":"/api/hello","function":"hello"}]},"functions":{"source":"functions"},"firestore":{}}', 'package.json': '{"scripts":{"build":"vite build"}}', '.firebaserc': '{"projects":{"prod":"demo-fn"}}', 'archive/evoting_flutter/pubspec.yaml': '', 'archive/evoting_flutter/ios/Runner.swift': '' },
    'dagangilat/your-content-creator': { 'firebase.json': '{"hosting":{"public":"dist","rewrites":[{"source":"/api/hello","function":"hello"}]},"functions":{"source":"functions"},"firestore":{}}', 'package.json': '{"scripts":{"build":"vite build"}}', '.firebaserc': '{"projects":{"default":"yourcontentcreator-f7ef5"}}' },
    'dagangilat/limorgilat.com': { 'backup-kit/backup.env': 'PROJECT_ID=limorgilat-com\n', 'app/firebase.json': '{}', 'app/.firebaserc': '{"projects":{"default":"limorgilat-com"}}' },
    'dagangilat/notes': {},
    'micromedia-ai/yourbackupagent': {
      'templates/backup-kit-wrapper.sh': tpl('templates/backup-kit-wrapper.sh'),
      'templates/backup.env.example': tpl('templates/backup.env.example'),
      'templates/backup.yml': tpl('templates/backup.yml'),
      'app/runner/onboard.sh': tpl('app/runner/onboard.sh'),
    },
  };
  let labels = { 'drill-of': 'other-app', 'drill-data': 'passed', 'drill-site': 'passed' };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    let m;
    if (req.method !== 'GET') calls.push({ method: req.method, path: p, body: json });
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/))) {
      const f = files[m[1]] && files[m[1]][decodeURIComponent(m[2])];
      return f === undefined ? send(404, { message: 'Not Found' }) : send(200, { content: b64(f), sha: 'sha1' });
    }
    if (p === '/user/repos') return send(200, Object.keys(files).map((r) => ({ full_name: r, private: true, archived: false, pushed_at: '2026-10-24T10:00:00Z' })));
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/runs$/))) {
      return send(200, { workflow_runs: m[2] === 'backup.yml' ? [{ id: 777, status: 'completed', conclusion: 'success', event: 'schedule', run_started_at: '2026-10-24T02:00:05Z', html_url: 'https://github.com/x/runs/777', name: 'Backup', run_number: 3, triggering_actor: { login: 'dagangilat' } }] : [] });
    }
    if (p.match(/\/actions\/workflows\/[^/]+\/dispatches$/)) return send(204);
    if (p.match(/\/actions\/secrets$/)) return send(200, { secrets: [{ name: 'FIREBASE_SERVICE_ACCOUNT_YCC' }] });
    if (p.match(/^\/repos\/micromedia-ai\/yourbackupagent\/tags$/)) return send(200, [{ name: 'v1' }, { name: 'v1.1' }]);
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)$/))) return send(200, { default_branch: 'main', full_name: m[1] });
    if (p.match(/\/git\/ref\/heads\//)) return send(200, { object: { sha: 'base' } });
    if (p.match(/\/git\/commits\/base$/)) return send(200, { tree: { sha: 'tree0' } });
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/git\/trees\/[^/]+$/)) && req.method === 'GET') {
      // Every file and the folders above it, as GitHub's recursive tree lists them.
      const paths = new Set();
      for (const f of Object.keys(files[m[1]] || {})) f.split('/').forEach((_, i, a) => paths.add(a.slice(0, i + 1).join('/')));
      return send(200, { tree: [...paths].map((x) => ({ path: x })) });
    }
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/git\/trees$/))) {
      // The pull request's files are readable afterwards (any ref).
      for (const f of json.tree) files[m[1]][f.path] = f.content;
      return send(201, { sha: 'tree1' });
    }
    if (p.match(/\/git\/commits$/)) return send(201, { sha: 'c1' });
    if (p.match(/\/git\/refs$/)) return send(201, {});
    if (p.match(/\/pulls$/) && req.method === 'GET') return send(200, []);
    if (p.match(/\/pulls$/)) return send(201, { number: 42, html_url: 'https://github.com/x/pull/42' });
    // Resend
    if (p === '/emails' && req.method === 'POST') { emails.push({ ...json, auth: req.headers.authorization }); return send(200, { id: `em_${emails.length}` }); }
    // Google
    if (p === '/v3/projects/demo-drill') return send(200, { labels });
    // A browser sign-in "ya29.<email>" (ya29.noscope: without Google Cloud access);
    // owners of every project are the accounts starting with owner@ or dagan.gilat@.
    if (p === '/tokeninfo') {
      const t = url.searchParams.get('access_token') || '';
      if (!t.startsWith('ya29.')) return send(400, { error_description: 'Invalid Value' });
      const email = t.slice(5);
      return send(200, { email, scope: email === 'noscope' ? 'openid email' : 'openid email https://www.googleapis.com/auth/cloud-platform', expires_in: '3500' });
    }
    if (p.match(/^\/v1\/projects\/[^/]+:testIamPermissions$/)) {
      const email = String(req.headers.authorization || '').replace(/^Bearer ya29\./, '');
      return send(200, /^(owner|dagan\.gilat)@/.test(email) ? { permissions: json.permissions } : {});
    }
    if (p.match(/\/jobs\/kit-runner:run$/)) return send(200, { name: 'op1', metadata: { name: 'projects/a/locations/us-central1/jobs/kit-runner/executions/exec-1' } });
    return send(404, { message: `fake: no route ${req.method} ${p}` });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls, emails, setLabels: (l) => { labels = l; } })));
}
