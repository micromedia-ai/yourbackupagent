import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteFacts, signIn, drillWorkflow, readSiteFacts } from '../lib/drill.js';

const herbpulse = JSON.stringify({
  hosting: { public: 'dist', rewrites: [{ source: '/api/aiChat', function: { functionId: 'aiChat' } }, { source: '**', destination: '/index.html' }] },
  firestore: { rules: 'firestore.rules' },
  functions: [{ source: 'functions', codebase: 'default' }],
});

test('site facts: root Vite app with functions and an API rewrite', () => {
  const f = siteFacts(herbpulse, { packages: { '.': { scripts: { build: 'vite build' } } } });
  assert.deepEqual(f, { dir: '.', web: '.', hostingTarget: '', functions: ['functions'], only: ['hosting', 'functions', 'firestore'], apiPath: '/api/aiChat' });
});

test('site facts: app in a subfolder with a hosting target, no build script means no build step', () => {
  const fb = JSON.stringify({ hosting: [{ target: 'foundation-global', public: 'evoting-frontend/dist' }], functions: { source: 'functions' }, storage: { rules: 's.rules' } });
  assert.deepEqual(siteFacts(fb, { packages: { 'evoting-frontend': { scripts: { build: 'vite build' } } } }),
    { dir: '.', web: 'evoting-frontend', hostingTarget: 'foundation-global', functions: ['functions'], only: ['hosting:foundation-global', 'functions', 'storage'], apiPath: '' });
  assert.equal(siteFacts(fb, { packages: {} }).web, null);
  // firebase.json in app/ (limorgilat.com): paths are from the repo root.
  const sub = siteFacts(JSON.stringify({ hosting: { public: 'dist' }, functions: { source: 'functions' } }), { base: 'app/', packages: { app: { scripts: { build: 'vite build' } } } });
  assert.deepEqual([sub.dir, sub.web, sub.functions], ['app', 'app', ['app/functions']]);
});

test('sign-in: keyless when backup.yml is, else the deploy key secret', () => {
  const wif = signIn('  workload_identity_provider: projects/1/locations/global/workloadIdentityPools/yourbackupagent/providers/github\n  service_account: ci@p.iam.gserviceaccount.com\n', 'X');
  assert.equal(wif.keyless, true);
  assert.deepEqual(wif.lines, ['workload_identity_provider: projects/1/locations/global/workloadIdentityPools/yourbackupagent/providers/github', 'service_account: ci@p.iam.gserviceaccount.com']);
  assert.deepEqual(signIn('credentials_json: ${{ secrets.K }}', 'FIREBASE_SERVICE_ACCOUNT_X'), { lines: ['credentials_json: ${{ secrets.FIREBASE_SERVICE_ACCOUNT_X }}'], keyless: false });
});

test('the workflow guards production, builds, deploys what firebase.json has, checks the backend', () => {
  const facts = siteFacts(herbpulse, { packages: { '.': { scripts: { build: 'vite build' } } } });
  const wf = drillWorkflow({ projectId: 'herbpulse-app', label: 'Herbpulse', facts, signIn: signIn('workload_identity_provider: P\nservice_account: S', '') });
  assert.match(wf, /PRODUCTION: herbpulse-app\n/);
  assert.match(wf, /"\$PRODUCTION"\) echo "::error::\$PROJECT is production"; exit 1/);
  assert.match(wf, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(wf, /id-token: write/);
  assert.match(wf, /workload_identity_provider: P\n {10}service_account: S\n/);
  assert.match(wf, /deploy --only hosting,functions,firestore --project "\$PROJECT"/);
  assert.match(wf, /API_PATH: '\/api\/aiChat'/);
  assert.match(wf, /npm run build/);
  assert.match(wf, /drill-site/);
  assert.doesNotMatch(wf, /target:apply/);
  const keyed = drillWorkflow({ projectId: 'p-app', label: 'P', facts, signIn: signIn('', 'K') });
  assert.doesNotMatch(keyed, /id-token/);
  assert.match(keyed, /credentials_json: \$\{\{ secrets\.K \}\}/);
});

test('reading a repository: firebase.json at the root or in app/, none means no workflow', async () => {
  const files = { 'app/firebase.json': JSON.stringify({ hosting: { public: 'dist' } }), 'app/package.json': '{"scripts":{"build":"vite build"}}' };
  const read = async (p) => (p in files ? { text: files[p] } : null);
  assert.deepEqual(await readSiteFacts(read), { dir: 'app', web: 'app', hostingTarget: '', functions: [], only: ['hosting'], apiPath: '' });
  assert.equal(await readSiteFacts(async () => null), null);
});
