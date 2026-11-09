// Offline end-to-end test of the manager app: the real web app (built for the
// emulators), the real API (functions emulator), Firestore and Auth emulators,
// backup sets in the Storage emulator, and a fake GitHub/Cloud Run. Drives a
// real browser through every page and action, and saves screenshots.
//
// Usage: node e2e/run.mjs   (needs firebase-tools: FIREBASE_BIN or npx)
// What it cannot prove: Google IAM, the real GitHub API, the Cloud Run job.
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startFakes } from './fake-apis.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const APP = new URL('..', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || `${APP}e2e/screens`;
const FIREBASE = process.env.FIREBASE_BIN || 'npx firebase-tools@14';
const ST = 'http://127.0.0.1:9199';
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`); };

function runId(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
const manifest = (id, status, docs) => ({
  kit: 1.1, project: 'demo-fn', id, trigger: 'schedule', status, startedAt: new Date().toISOString(), finishedAt: new Date(Date.now() + 600000).toISOString(),
  steps: { firestore: 'ok', storage: 'ok', auth: status === 'failed' ? 'failed' : 'ok', rtdb: 'ok', config: 'ok', offsite: status === 'failed' ? undefined : 'ok' },
  firestore: { '(default)': { collections: { users: 34, polls: docs } } }, storage: { 'demo-fn.firebasestorage.app': { objects: 872 } },
  auth: { users: 34 }, errors: status === 'failed' ? ['auth: batchGet 500'] : [],
});

async function put(bucket, name, data) {
  const r = await fetch(`${ST}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/octet-stream' }, body: data,
  });
  if (!r.ok) throw new Error(`upload ${bucket}/${name}: ${r.status} ${await r.text()}`);
}
async function list(bucket, prefix) {
  const r = await fetch(`${ST}/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(prefix)}`, { headers: { authorization: 'Bearer owner' } });
  return ((await r.json()).items || []).map((i) => i.name);
}

async function waitFor(url, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${url}`);
}

const PORTS = [9099, 8086, 5001, 9199, 5055, 4400, 4500];
async function portsFree(ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const busy = [];
    for (const p of PORTS) { try { await fetch(`http://127.0.0.1:${p}/`); busy.push(p); } catch {} }
    if (!busy.length) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('emulator ports still busy (an earlier run is still stopping)');
}

function freePorts() {
  for (const p of [...PORTS, 4401, 4501, 9150, 9151]) { try { execSync(`fuser -k -n tcp ${p}`, { stdio: 'ignore' }); } catch {} }
}

async function main() {
  freePorts();
  await portsFree();
  // Functions settings for the emulator only (removed afterwards).
  writeFileSync(`${APP}functions/.env.local`, 'GITHUB_API=http://127.0.0.1:4999\nFAKE_GOOGLE_API=http://127.0.0.1:4999\nRUNNER_SA=runner@demo-yba.iam.gserviceaccount.com\nOWNER_EMAILS=dagan.gilat@gmail.com\nSTORAGE_EMULATOR_HOST=http://127.0.0.1:9199\nRESEND_API=http://127.0.0.1:4999\nAPP_URL=http://127.0.0.1:5055\nMAIL_FROM="YourBackupAgent <backups@plantagoai.com>"\n');
  writeFileSync(`${APP}functions/.secret.local`, 'GITHUB_TOKEN=fake-token\nRESEND_API_KEY=re_fake\n');
  execSync('npx vite build', { cwd: APP, stdio: 'inherit', env: { ...process.env, VITE_USE_EMULATORS: 'true' } });
  const fakes = await startFakes();
  const emu = spawn('sh', ['-c', `${FIREBASE} emulators:start --project demo-yba`], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] });
  let emuLog = '';
  emu.stdout.on('data', (d) => { emuLog += d; });
  emu.stderr.on('data', (d) => { emuLog += d; });
  try {
    const end = Date.now() + 180000;
    while (!emuLog.includes('All emulators ready') && Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
    await waitFor('http://127.0.0.1:5055/');

    // Backup sets: 5 good + 1 failed in the project bucket, the 5 good in the vault.
    const good = [1, 25, 49, 73, 97].map(runId);
    const failed = runId(0.5);
    for (const [i, id] of good.entries()) {
      for (const b of ['demo-fn-backups', 'demo-vault-fn']) {
        await put(b, `runs/${id}/firestore/(default)/export.overall_export_metadata`, 'x'.repeat(1000 * (i + 1)));
        await put(b, `runs/${id}/manifest.json`, JSON.stringify(manifest(id, 'succeeded', 3 + i)));
      }
    }
    await put('demo-fn-backups', `runs/${failed}/manifest.json`, JSON.stringify(manifest(failed, 'failed', 0)));

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    globalThis.__page = page;
    page.on('pageerror', (e) => console.log('page error:', e.message));
    page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
    page.on('requestfailed', (r) => console.log('requestfailed:', r.url()));
    await page.goto('http://127.0.0.1:5055/');
    await page.getByRole('button', { name: 'Sign in with Google' }).waitFor();
    check('signed out: the landing page says invite only and lists what it does', await page.getByText('Invite only').count() > 0 && await page.locator('.feature').count() === 6);
    await page.screenshot({ path: `${SHOTS}/0-landing.png`, fullPage: true });

    await page.evaluate(() => window.__testSignIn('dagan.gilat@gmail.com'));
    await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 30000 });
    check('owner signs in and passes the access check', true);

    await page.getByRole('button', { name: 'Refresh now' }).click();
    await page.getByText('Refreshed every project.').waitFor({ timeout: 60000 });
    const card = page.locator('.pcard', { hasText: 'Foundation Next' });
    await card.waitFor();
    check('refresh reads the project from its repository backup.env', true);
    check('health is shown (newest run failed -> warning)', (await card.textContent()).includes('The newest run failed'), await card.textContent());
    check('drill slot shows who holds the drill project', await page.getByText('holds a drill of other-app').count() > 0);
    check('drill slot links the rebuilt site when its site part passed', (await page.locator('#drill-site-link').first().getAttribute('href'))?.match(/^https:\/\/[a-z0-9-]*drill[a-z0-9-]*\.web\.app$/) != null);
    check('overview: 5 headline numbers and the nightly grid', await page.locator('.kpi').count() === 5 && await page.locator('.sgrid .cell.failed').count() >= 1);
    // Alerts live behind the bell; a hidden one stays hidden until its text changes.
    const badge = async () => (await page.locator('.bell-n').count()) ? Number(await page.locator('.bell-n').textContent()) : 0;
    const before = await badge();
    await page.locator('#bell').click();
    const listed = await page.locator('.bell-item', { hasText: 'Foundation Next' }).count();
    await page.locator('.bell-item', { hasText: 'Foundation Next' }).getByRole('button', { name: 'Hide' }).click();
    const after = await badge();
    await page.reload();
    await page.locator('.kpi').first().waitFor({ timeout: 30000 });
    const afterReload = await badge();
    await page.locator('#bell').click();
    await page.getByRole('button', { name: /Show 1 hidden/ }).click();
    check('the bell counts alerts, lists Foundation Next, and Hide keeps it hidden across a reload until shown again',
      before >= 1 && listed === 1 && after === before - 1 && afterReload === before - 1 && await badge() === before, JSON.stringify({ before, listed, after, afterReload }));
    await page.keyboard.press('Escape');
    // A size-watch note keeps the project Healthy on its card and shows under the bell only.
    const fnDoc = 'http://127.0.0.1:8086/v1/projects/demo-yba/databases/(default)/documents/projects/demo-fn';
    const savedHealth = (await (await fetch(fnDoc, { headers: { authorization: 'Bearer owner' } })).json()).fields.health;
    const patchHealth = (health) => fetch(`${fnDoc}?updateMask.fieldPaths=health`, { method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify({ fields: { health } }) });
    await patchHealth({ mapValue: { fields: { level: { stringValue: 'ok' }, text: { stringValue: 'Healthy' }, notes: { arrayValue: { values: [{ stringValue: 'Backups take 94 GB (watch level 20 GB)' }] } } } } });
    await page.locator('.pcard', { hasText: 'Foundation Next' }).getByText('Healthy').waitFor({ timeout: 30000 });
    const cardText = await card.textContent();
    await page.locator('#bell').click();
    const noteListed = await page.locator('.bell-item', { hasText: 'watch level' }).count();
    check('a size-watch note: the card says Healthy with no size pill, the bell lists it', !cardText.includes('watch level') && noteListed === 1 && await page.locator('.kpi', { hasText: '1 of 1' }).count() === 1, JSON.stringify({ cardText, noteListed }));
    await page.keyboard.press('Escape');
    await patchHealth(savedHealth);
    await page.locator('.pcard', { hasText: 'The newest run failed' }).waitFor({ timeout: 30000 });
    await page.screenshot({ path: `${SHOTS}/1-overview.png`, fullPage: true });

    await card.click();
    await page.getByRole('heading', { name: 'Foundation Next' }).waitFor();
    await page.locator('table.sets tbody tr').first().waitFor();
    const rows = await page.locator('table.sets tbody tr').count();
    check('project page lists all 6 sets', rows === 6, String(rows));
    // No rebuild-drill.yml in the repo: the page says drills are data only and offers the site drill.
    await page.locator('#add-site-drill').click();
    await page.getByText('Pull request opened: the site drill').waitFor({ timeout: 30000 });
    const siteTree = fakes.calls.filter((c) => c.path === '/repos/dagangilat/foundation-next/git/trees').pop();
    const siteFile = siteTree && siteTree.body.tree.find((f) => f.path === '.github/workflows/rebuild-drill.yml');
    check('a project without a site drill gets one by pull request', Boolean(siteFile) && siteFile.content.includes('PRODUCTION: demo-fn') && siteTree.body.tree.length === 1, JSON.stringify(siteTree?.body.tree.map((f) => f.path)));
    check('the project page shows the detected drill parts (archived Flutter app skipped)', await page.getByText('Rebuild drills check: data, web, api').count() === 1 && await page.getByText('detected from the repo', { exact: false }).count() > 0);
    await page.screenshot({ path: `${SHOTS}/2-project.png`, fullPage: true });

    // Delete the two oldest good sets with min 3: allowed for one... check refusal first.
    const oldest = good.slice(-3);
    for (const id of oldest) await page.locator(`#sel-${id}`).check();
    await page.getByRole('button', { name: /Delete 3 selected/ }).click();
    check('deleting 3 of 5 good sets with minimum 3 is refused in the page', await page.getByText(/Not allowed: would leave 2 good sets/).count() > 0);
    await page.screenshot({ path: `${SHOTS}/3-delete-refused.png` });
    await page.getByRole('button', { name: 'Close' }).click();
    await page.locator(`#sel-${oldest[0]}`).uncheck();

    // Delete 2 (project + vault): leaves 3 good in both.
    await page.getByRole('button', { name: /Delete 2 selected/ }).click();
    await page.locator('#where-both').check();
    await page.locator('#confirm-delete').fill('delete 2');
    await page.getByRole('button', { name: 'Delete 2', exact: true }).click();
    await page.getByText(/Deleted 2 project and 2 vault copies/).waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'Close' }).click();
    const leftP = await list('demo-fn-backups', 'runs/');
    const leftV = await list('demo-vault-fn', 'runs/');
    check('the 2 sets are gone from the project bucket', !leftP.some((n) => oldest.slice(1).some((id) => n.includes(id))) && leftP.some((n) => n.includes(good[0])));
    check('and from the vault (deleted with the owner\'s own token)', !leftV.some((n) => oldest.slice(1).some((id) => n.includes(id))) && leftV.some((n) => n.includes(good[0])));

    // Restore dialog: rebuild drill into the drill project, replacing other-app's drill.
    await page.locator('tr', { hasText: good[0] }).getByRole('button', { name: 'Restore…' }).click();
    await page.locator('#replace').check();
    await page.getByRole('button', { name: 'Start rebuild drill' }).click();
    await page.getByText(/Rebuild drill started/).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Close' }).click();
    const job = fakes.calls.find((c) => c.path.endsWith('/jobs/kit-runner:run'));
    const ov = job && job.body.overrides.containerOverrides[0];
    const env = ov ? Object.fromEntries(ov.env.map((e) => [e.name, e.value])) : {};
    check('rebuild starts the runner job with the kit command', ov && ov.args.join(' ') === `rebuild --run ${good[0]} --yes --replace`, JSON.stringify(ov && ov.args));
    check('the job gets the repository backup.env, the kit version and its log line', Buffer.from(env.BACKUP_ENV_B64 || '', 'base64').toString().includes('PROJECT_ID=demo-fn') && env.KIT_REF === 'v1.1' && /^log\/\w+$/.test(env.LOG_DOC || ''));
    // A second rebuild while the first runs is refused (one drill at a time).
    await page.locator('tr', { hasText: good[0] }).getByRole('button', { name: 'Restore…' }).click();
    await page.locator('#replace').check();
    await page.getByRole('button', { name: 'Start rebuild drill' }).click();
    await page.getByText(/The drill project is busy: rebuild drill of demo-fn/).waitFor({ timeout: 30000 });
    check('a second rebuild drill while one runs is refused', fakes.calls.filter((c) => c.path.endsWith('/jobs/kit-runner:run')).length === 1);
    await page.getByRole('button', { name: 'Close' }).click();
    await page.locator('tr', { hasText: good[0] }).getByRole('button', { name: 'Restore…' }).click();
    await page.locator('#t-prod').check();
    check('production restore is a command to run, not a button', (await page.locator('.code pre').textContent()).includes(`backup-kit/backup.sh restore --to demo-fn --run ${good[0]}`));
    await page.screenshot({ path: `${SHOTS}/4-restore.png` });
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Back up now' }).click();
    await page.getByText(/Backup started in GitHub/).waitFor({ timeout: 30000 });
    const disp = fakes.calls.find((c) => c.path.endsWith('/backup.yml/dispatches'));
    check('back up now starts the project\'s Backup workflow', disp && disp.body.inputs.action === 'run' && disp.body.ref === 'main');

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Pause backups' }).click();
    await page.getByRole('button', { name: 'Resume backups' }).waitFor({ timeout: 30000 });
    check('pause turns the Backup workflow off in GitHub', fakes.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/backup.yml/disable')));
    check('a paused project says so, without Back up now', await page.getByText('Backups paused', { exact: true }).count() > 0 && await page.getByRole('button', { name: 'Back up now' }).isDisabled());
    await page.screenshot({ path: `${SHOTS}/4b-paused.png` });
    await page.getByRole('button', { name: 'Resume backups' }).click();
    await page.getByRole('button', { name: 'Pause backups' }).waitFor({ timeout: 30000 });
    check('resume turns the Backup workflow back on', fakes.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/backup.yml/enable')));

    await page.goto('http://127.0.0.1:5055/log');
    await page.locator('.log li').first().waitFor();
    const logText = await page.locator('.log').textContent();
    for (const a of ['delete sets', 'delete vault copies', 'rebuild drill', 'back up now', 'nightly backup', 'create access list']) {
      check(`log has "${a}"`, logText.includes(a), '');
    }
    await page.screenshot({ path: `${SHOTS}/5-log.png`, fullPage: true });

    await page.goto('http://127.0.0.1:5055/reports');
    await page.getByRole('heading', { name: 'Reports' }).waitFor();
    await page.locator('svg.chart').first().waitFor();
    check('reports draw charts', await page.locator('svg.chart').count() >= 3 && await page.locator('.hbar').count() >= 2);
    await page.getByRole('button', { name: '7 days' }).click();
    check('reports switch to 7 days', await page.getByText('Every night, last 7 days').count() === 1 && await page.locator('.sgrid .cell').count() === 7);
    await page.getByRole('button', { name: '30 days' }).click();
    await page.screenshot({ path: `${SHOTS}/6-reports.png`, fullPage: true });

    await page.goto('http://127.0.0.1:5055/protect');
    await page.getByRole('button', { name: 'List my Firebase repositories' }).click();
    await page.locator('#repo-dagangilat\\/your-content-creator').check();
    check('protect lists Firebase repositories only', await page.getByText('dagangilat/notes').count() === 0 && await page.getByText('not protected').count() === 1);
    check('protect lists a repo whose Firebase app is in app/', await page.locator('#repo-dagangilat\\/limorgilat\\.com').count() === 1 && await page.getByText('limorgilat-com', { exact: true }).count() === 1);
    await page.getByRole('button', { name: 'Open the pull request' }).click();
    await page.locator('#set-up-here').waitFor({ timeout: 30000 });
    const tree = fakes.calls.find((c) => c.path === '/repos/dagangilat/your-content-creator/git/trees');
    const envFile = tree && tree.body.tree.find((f) => f.path === 'backup-kit/backup.env');
    check('the pull request carries the kit files, filled in', envFile && /PROJECT_ID=yourcontentcreator-f7ef5/.test(envFile.content) && /KEEP_MIN_SETS=7/.test(envFile.content) && /OFFSITE_BUCKET=yourbackupagent-yourcontentcreator/.test(envFile.content)
      && tree.body.tree.some((f) => f.path === '.github/workflows/backup.yml' && f.content.includes('secrets.FIREBASE_SERVICE_ACCOUNT_YCC') && f.content.includes('yourbackupagent@v1.1')));
    const drillFile = tree && tree.body.tree.find((f) => f.path === '.github/workflows/rebuild-drill.yml');
    check('the pull request carries a site drill made from firebase.json', Boolean(drillFile) && drillFile.content.includes('PRODUCTION: yourcontentcreator-f7ef5') && drillFile.content.includes('npm run build')
      && drillFile.content.includes('--only hosting,functions,firestore') && drillFile.content.includes("API_PATH: '/api/hello'") && drillFile.content.includes('secrets.FIREBASE_SERVICE_ACCOUNT_YCC'), drillFile ? drillFile.content.slice(0, 200) : 'missing');
    await page.getByText('Or on your computer').click();
    check('protect still shows the one computer command to finish', (await page.locator('.code pre').allTextContents()).some((t) => t.includes('./onboard.sh dagangilat/your-content-creator')));

    // "Set it up here": a browser sign-in as the project owner (and the vault owner).
    const jobsBefore = fakes.calls.filter((c) => c.path.endsWith('/jobs/kit-runner:run')).length;
    await page.evaluate(() => { window.__testCloudSignIn = async (hint) => { const email = hint || window.__cloudAccount; return { email, token: `ya29.${email}` }; }; window.__cloudAccount = 'stranger@example.com'; });
    await page.locator('#owner-sign-in').click();
    await page.locator('#start-setup').click();
    await page.getByText('stranger@example.com is not an owner of yourcontentcreator-f7ef5').waitFor({ timeout: 30000 });
    check('set it up refuses a sign-in that does not own the project', fakes.calls.filter((c) => c.path.endsWith('/jobs/kit-runner:run')).length === jobsBefore);
    await page.evaluate(() => { window.__cloudAccount = 'owner@example.com'; });
    await page.locator('#owner-sign-in').click();
    await page.locator('#start-setup').click();
    await page.getByText('Also sign in as the vault owner, dagan.gilat@gmail.com.').first().waitFor({ timeout: 30000 });
    check('set it up asks for the vault owner when the project owner is another account', await page.locator('#vault-sign-in').count() === 1 && await page.locator('#start-setup').isDisabled());
    await page.locator('#vault-sign-in').click();
    await page.locator('#start-setup').click();
    await page.locator('#setup-progress').waitFor({ timeout: 30000 });
    const ob = fakes.calls.filter((c) => c.path.endsWith('/jobs/kit-runner:run')).pop();
    const obo = ob && ob.body.overrides.containerOverrides[0];
    const obEnv = obo ? Object.fromEntries(obo.env.map((e) => [e.name, e.value])) : {};
    check('set it up starts the runner with the pull request settings and a one-time sign-in document', obo && obo.args.length === 0 && /^onboard\/\w+$/.test(obEnv.ONBOARD_DOC || '')
      && Buffer.from(obEnv.BACKUP_ENV_B64 || '', 'base64').toString().includes('PROJECT_ID=yourcontentcreator-f7ef5') && obEnv.KIT_REF === 'v1.1', JSON.stringify(obEnv));
    check('no sign-in token goes to the runner job itself', !JSON.stringify(ob.body).includes('ya29'));
    const obDoc = await (await fetch(`http://127.0.0.1:8086/v1/projects/demo-yba/databases/(default)/documents/${obEnv.ONBOARD_DOC}`, { headers: { authorization: 'Bearer owner' } })).json();
    const f = (k) => obDoc.fields && obDoc.fields[k] && obDoc.fields[k].stringValue;
    check('the sign-in document holds both sign-ins for the runner', f('ownerToken') === 'ya29.owner@example.com' && f('vaultToken') === 'ya29.dagan.gilat@gmail.com' && f('repo') === 'dagangilat/your-content-creator' && f('branch') === 'main');
    const obDenied = await page.evaluate(async (path) => {
      const r = await fetch(`http://127.0.0.1:8086/v1/projects/demo-yba/databases/(default)/documents/${path}`, { headers: { authorization: `Bearer ${await window.__idToken()}` } });
      return r.status;
    }, obEnv.ONBOARD_DOC).catch(() => 0);
    check('the browser cannot read the sign-in document', obDenied === 403, String(obDenied));
    await fetch(`http://127.0.0.1:8086/v1/projects/demo-yba/databases/(default)/documents/${obEnv.LOG_DOC}?updateMask.fieldPaths=status&updateMask.fieldPaths=detail`, {
      method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { status: { stringValue: 'succeeded' }, detail: { stringValue: 'SET UP: yourcontentcreator-f7ef5. Merge the pull request so the nightly backup runs.' } } }),
    });
    await page.locator('#setup-progress').getByText('set up', { exact: true }).waitFor({ timeout: 30000 });
    check('set it up shows the runner\'s result live', await page.locator('.log-detail').getByText(/SET UP: yourcontentcreator-f7ef5/).count() === 1);
    await page.screenshot({ path: `${SHOTS}/7-protect.png`, fullPage: true });

    await page.goto('http://127.0.0.1:5055/settings');
    await page.locator('#min-demo-fn').fill('5');
    await page.locator('tr', { has: page.locator('#min-demo-fn') }).getByRole('button', { name: 'Open pull request' }).click();
    await page.getByText('Pull request opened. Merge it to apply.').waitFor({ timeout: 30000 });
    const minTree = fakes.calls.filter((c) => c.path === '/repos/dagangilat/foundation-next/git/trees').pop();
    check('changing the minimum opens a pull request with KEEP_MIN_SETS=5', minTree && /KEEP_MIN_SETS=5/.test(minTree.body.tree[0].content));
    await page.locator('#mode-demo-fn').selectOption('changed');
    await page.locator('tr', { has: page.locator('#mode-demo-fn') }).getByRole('button', { name: 'Open pull request' }).click();
    await page.getByText('Pull request opened. Merge it to apply from the next backup.').waitFor({ timeout: 30000 });
    const modeTree = fakes.calls.filter((c) => c.path === '/repos/dagangilat/foundation-next/git/trees').pop();
    check('choosing changed-only media copies opens a pull request with STORAGE_MODE=changed', modeTree && /STORAGE_MODE=changed/.test(modeTree.body.tree[0].content) && /KEEP_MIN_SETS=/.test(modeTree.body.tree[0].content));
    await page.locator('#name-demo-fn').fill('Foundation Brand');
    await page.locator('tr', { has: page.locator('#name-demo-fn') }).getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved: demo-fn now shows as Foundation Brand.').waitFor({ timeout: 30000 });
    const nameTree = fakes.calls.filter((c) => c.path === '/repos/dagangilat/foundation-next/git/trees').pop();
    check('renaming a project saves it in the app at once, without a pull request', nameTree === modeTree && await page.locator('td', { hasText: /^Foundation Brand$/ }).count() > 0, JSON.stringify(nameTree?.body?.tree?.[0]?.path));
    // Empty: back to the name in backup.env.
    await page.locator('#name-demo-fn').fill('');
    await page.locator('tr', { has: page.locator('#name-demo-fn') }).getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved: demo-fn now shows as Foundation Next.').waitFor({ timeout: 30000 });
    check('an empty display name goes back to PROJECT_LABEL from backup.env', await page.locator('tr', { has: page.locator('#name-demo-fn') }).getByText('(from backup.env)').count() === 1);
    await page.locator('#part-demo-fn-service').check();
    await page.locator('#health-demo-fn').fill('/api/health');
    await page.locator('tr', { has: page.locator('#health-demo-fn') }).getByRole('button', { name: 'Open pull request' }).click();
    await page.getByText(/Pull request opened\. Merge it, then refresh\. Older site drill/).waitFor({ timeout: 30000 });
    const partsTree = fakes.calls.filter((c) => c.path === '/repos/dagangilat/foundation-next/git/trees').pop();
    const partsEnv = partsTree && partsTree.body.tree[0].content;
    check('changing drill parts opens a pull request with DRILL_PARTS="web api service" and HEALTH_PATH', /\nDRILL_PARTS="web api service"\n/.test(partsEnv) && /\nHEALTH_PATH=\/api\/health\n/.test(partsEnv) && /STORAGE_MODE=changed/.test(partsEnv), partsEnv);
    // Email alerts.
    const sent = () => fakes.emails.map((e) => e.subject);
    await page.getByRole('button', { name: 'Send me a test' }).click();
    await page.getByText(/Sent you this week's summary/).waitFor({ timeout: 30000 });
    const test = fakes.emails.find((e) => /^Weekly backups:/.test(e.subject));
    check('test email: the weekly summary, to the caller only, from the plantagoai sender, with the key', test && test.to.join() === 'dagan.gilat@gmail.com' && /backups@plantagoai\.com/.test(test.from) && test.auth === 'Bearer re_fake', JSON.stringify(sent()));
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.getByText(/Emailed: demo-fn needs attention/).waitFor({ timeout: 30000 });
    check('check now emails that Foundation Next needs attention', sent().some((s) => /^Backups need attention: Foundation Next/.test(s)));
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.getByText(/nothing changed since the last check/).waitFor({ timeout: 30000 });
    check('a second check sends nothing new', sent().filter((s) => /need attention/.test(s)).length === 1);
    // The runner job ends the rebuild drill's log line: a drill email follows.
    await fetch(`http://127.0.0.1:8086/v1/projects/demo-yba/databases/(default)/documents/${env.LOG_DOC}?updateMask.fieldPaths=status&updateMask.fieldPaths=detail`, {
      method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { status: { stringValue: 'succeeded' }, detail: { stringValue: 'rebuild: all counts match' } } }),
    });
    const t0 = Date.now();
    while (!sent().some((s) => /^Rebuild drill passed: Foundation Next/.test(s)) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 500));
    check('a finished drill is emailed right away', sent().some((s) => /^Rebuild drill passed: Foundation Next/.test(s)), JSON.stringify(sent()));
    await new Promise((r) => setTimeout(r, 5000));
    const lockDoc = await fetch('http://127.0.0.1:8086/v1/projects/demo-yba/databases/(default)/documents/drill/lock', { headers: { authorization: 'Bearer owner' } });
    check('the finished drill frees the drill project', lockDoc.status === 404, String(lockDoc.status));
    check('exactly once (the email log line does not trigger another)', sent().filter((s) => /^Rebuild drill/.test(s)).length === 1, String(sent().filter((s) => /^Rebuild drill/.test(s)).length));
    // Size watch levels are saved for the next refresh (the health rule itself is unit tested).
    await page.locator('#watch-set').fill('1.5');
    await page.locator('#watch-total').fill('30');
    await page.locator('section', { hasText: 'Backup size watch' }).getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved. It applies from the next refresh.').waitFor({ timeout: 30000 });
    const cfg = await (await fetch('http://127.0.0.1:8086/v1/projects/demo-yba/databases/(default)/documents/config/settings', { headers: { authorization: 'Bearer owner' } })).json();
    check('size watch levels are saved', Number(cfg.fields?.sizeWarnSetGB?.doubleValue) === 1.5 && Number(cfg.fields?.sizeWarnTotalGB?.integerValue ?? cfg.fields?.sizeWarnTotalGB?.doubleValue) === 30, JSON.stringify(cfg.fields || cfg));
    await page.screenshot({ path: `${SHOTS}/8-settings.png`, fullPage: true });

    // MCP connector: discovery, sign-in as the owner, tools with the app's rules, disconnect.
    const H = 'http://127.0.0.1:5055';
    const prm = await (await fetch(`${H}/.well-known/oauth-protected-resource/mcp`)).json();
    check('MCP: discovery names this app\'s /mcp and its sign-in', prm.resource === `${H}/mcp` && (await (await fetch(`${H}/.well-known/oauth-authorization-server`)).json()).authorization_endpoint === `${H}/connect-ai`, JSON.stringify(prm));
    const rpc = (token, method, params = {}) => fetch(`${H}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const anon = await rpc('', 'tools/list');
    check('MCP: without sign-in it answers 401 and points at the sign-in', anon.status === 401 && /resource_metadata="http:\/\/127\.0\.0\.1:5055\/\.well-known\/oauth-protected-resource\/mcp"/.test(anon.headers.get('www-authenticate') || ''));
    const CB = 'https://claude.ai/api/mcp/auth_callback';
    const client = await (await fetch(`${H}/mcp/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CB] }) })).json();
    const { createHash, randomBytes } = await import('node:crypto');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let backTo = '';
    await page.route('https://claude.ai/**', (r) => { backTo = r.request().url(); return r.fulfill({ status: 200, body: 'back in Claude' }); });
    await page.goto(`${H}/connect-ai?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(CB)}&state=st8&code_challenge=${challenge}&code_challenge_method=S256`);
    await page.getByText('Claude asks to use YourBackupAgent as you').waitFor({ timeout: 30000 });
    await page.screenshot({ path: `${SHOTS}/12-connect-ai.png` });
    await page.getByRole('button', { name: 'Allow' }).click();
    const tb = Date.now();
    while (!backTo && Date.now() - tb < 30000) await new Promise((r) => setTimeout(r, 300));
    const back = new URL(backTo || 'http://x/');
    check('MCP: Allow sends Claude back with a code and its state', back.searchParams.get('state') === 'st8' && !!back.searchParams.get('code'), backTo);
    const tok = await (await fetch(`${H}/mcp/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code') || '', client_id: client.client_id, redirect_uri: CB, code_verifier: verifier }) })).json();
    check('MCP: the code becomes an access token (form-encoded, PKCE)', /^ybat_/.test(tok.access_token || ''), JSON.stringify(tok));
    const tool = async (name, args = {}) => (await (await rpc(tok.access_token, 'tools/call', { name, arguments: args })).json()).result;
    const tools = (await (await rpc(tok.access_token, 'tools/list')).json()).result.tools.map((t) => t.name);
    check('MCP: lists the backup tools', ['get_overview', 'list_sets', 'back_up_now', 'rebuild_drill', 'delete_sets', 'production_restore_command'].every((t) => tools.includes(t)), tools.join());
    const mov = await tool('get_overview');
    check('MCP: overview shows Foundation Next with its health', mov.structuredContent.projects.some((x) => x.projectId === 'demo-fn' && x.health && x.health.level), JSON.stringify(mov).slice(0, 300));
    const ls = await tool('list_sets', { project: 'demo-fn' });
    check('MCP: lists the sets that are left', ls.structuredContent.sets.length === 4, JSON.stringify(ls).slice(0, 300));
    const pv = await tool('delete_sets', { project: 'demo-fn', run_ids: [good[2]] });
    check('MCP: delete without confirm only says it is not allowed (would go below the minimum)', pv.structuredContent.preview === true && pv.structuredContent.allowed === false && (await list('demo-fn-backups', `runs/${good[2]}/`)).length > 0, JSON.stringify(pv));
    const del = await tool('delete_sets', { project: 'demo-fn', run_ids: [good[2]], confirm: true });
    check('MCP: delete with confirm is refused by the same rule, and nothing is deleted', del.isError === true && /would leave 2 good sets/.test(del.structuredContent.error) && (await list('demo-fn-backups', `runs/${good[2]}/`)).length > 0, JSON.stringify(del));
    const disp0 = fakes.calls.filter((c) => c.path.endsWith('/backup.yml/dispatches')).length;
    const bk = await tool('back_up_now', { project: 'demo-fn' });
    check('MCP: back up now starts the Backup workflow', !bk.isError && fakes.calls.filter((c) => c.path.endsWith('/backup.yml/dispatches')).length === disp0 + 1, JSON.stringify(bk));
    const rcmd = await tool('production_restore_command', { project: 'demo-fn', run_id: good[0] });
    check('MCP: production restore is a command, never done from here', (rcmd.structuredContent.command || '').includes(`backup-kit/backup.sh restore --to demo-fn --run ${good[0]}`));
    const lg = await tool('get_log', { limit: 10 });
    check('MCP: its changes are logged with the person and the assistant', lg.structuredContent.log.some((l) => l.action === 'back up now' && l.by === 'dagan.gilat@gmail.com via Claude') && lg.structuredContent.log.some((l) => l.action === 'delete sets' && l.status === 'refused'), JSON.stringify(lg.structuredContent.log.slice(0, 4)));
    await page.goto(`${H}/settings`);
    const grantRow = page.locator('.grants li', { hasText: 'Claude' });
    await grantRow.waitFor({ timeout: 30000 });
    check('Settings lists the connected assistant and the connector address', (await page.locator('#connector-url').textContent()) === `${H}/mcp`);
    await grantRow.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByText('Disconnected Claude.').waitFor({ timeout: 30000 });
    check('MCP: after Disconnect the token stops working', (await rpc(tok.access_token, 'tools/list')).status === 401);
    await page.unroute('https://claude.ai/**');

    // Phone width.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const pp = await phone.newPage();
    await pp.goto('http://127.0.0.1:5055/');
    await pp.getByRole('button', { name: 'Sign in with Google' }).waitFor();
    await pp.evaluate(() => window.__testSignIn('dagan.gilat@gmail.com'));
    await pp.locator('.pcard', { hasText: 'Foundation Next' }).waitFor({ timeout: 30000 }).catch(() => {});
    await pp.screenshot({ path: `${SHOTS}/9-phone-overview.png`, fullPage: true });
    await pp.goto('http://127.0.0.1:5055/projects/demo-fn');
    await pp.locator('table.sets tbody tr').first().waitFor({ timeout: 30000 }).catch(() => {});
    await pp.screenshot({ path: `${SHOTS}/10-phone-project.png`, fullPage: true });
    check('phone: project page shows the sets', await pp.locator('table.sets tbody tr').count() > 0);
    const wide = await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check('phone: no sideways page scroll', !wide);
    await pp.locator('#bell').click();
    const panel = await pp.locator('.bell-panel').boundingBox();
    const vw = await pp.evaluate(() => window.innerWidth);
    check('phone: the bell is there and its panel fits the screen', !!panel && panel.x >= 0 && panel.x + panel.width <= vw + 1, JSON.stringify({ panel, vw }));

    // Invite only: a stranger asks, the owner approves, the stranger gets in.
    const other = await browser.newContext();
    const op = await other.newPage();
    await op.goto('http://127.0.0.1:5055/');
    await op.getByRole('button', { name: 'Sign in with Google' }).waitFor();
    await op.evaluate(() => window.__testSignIn('stranger@example.com'));
    await op.getByRole('button', { name: 'Ask for access' }).waitFor({ timeout: 30000 });
    check('someone not on the list gets the ask-for-access page, not the app', await op.getByRole('heading', { name: 'Overview' }).count() === 0);
    await op.locator('#ask-note').fill('I look after the shop');
    await op.getByRole('button', { name: 'Ask for access' }).click();
    await op.getByText(/Asked\. The owner got an email/).waitFor({ timeout: 30000 });
    await op.screenshot({ path: `${SHOTS}/11-ask-for-access.png` });
    // The page says "Asked" as soon as the request is stored; the email goes out right after.
    const askT0 = Date.now();
    const findAsk = () => fakes.emails.find((e) => e.subject === 'stranger@example.com asks for access to YourBackupAgent');
    while (!findAsk() && Date.now() - askT0 < 15000) await new Promise((r) => setTimeout(r, 300));
    const ask = findAsk();
    check('the owner is emailed about the request', ask && ask.to.join() === 'dagan.gilat@gmail.com' && ask.html.includes('I look after the shop'));
    await page.goto('http://127.0.0.1:5055/settings');
    await page.locator('.requests li', { hasText: 'stranger@example.com' }).getByRole('button', { name: 'Approve' }).click();
    await page.getByText('stranger@example.com can sign in now').waitFor({ timeout: 30000 });
    check('approving emails the person a link', fakes.emails.some((e) => e.subject === 'You have access to YourBackupAgent' && e.to.join() === 'stranger@example.com'));
    await op.reload();
    await op.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 30000 });
    check('once approved, they get into the app', true);
    await page.locator('#invite-email').fill('friend@example.com');
    await page.getByRole('button', { name: 'Invite' }).click();
    await page.getByText('Invited and emailed.').waitFor({ timeout: 30000 });
    check('invite adds the address and emails it', fakes.emails.some((e) => e.to.join() === 'friend@example.com') && (await page.locator('#emails').inputValue()).includes('friend@example.com'));
    await browser.close();
  } catch (e) {
    check('test ran to the end', false, e.stack);
    try { await globalThis.__page?.screenshot({ path: `${SHOTS}/failure.png` }); console.log('body:', (await globalThis.__page?.textContent('body'))?.slice(0, 500)); } catch {}
    console.log(emuLog.split('\n').slice(-40).join('\n'));
  } finally {
    emu.kill('SIGINT');
    fakes.server.close();
    await new Promise((r) => setTimeout(r, 3000));
    rmSync(`${APP}functions/.env.local`, { force: true });
    rmSync(`${APP}functions/.secret.local`, { force: true });
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
  process.exit(bad.length ? 1 : 0);
}

mkdirSync(SHOTS, { recursive: true });
main();
