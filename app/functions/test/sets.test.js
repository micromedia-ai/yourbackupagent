import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, prunePlan, canDelete, health, cutoffId, runTime } from '../lib/sets.js';
import { parseEnv, projectSettings, setEnvValue } from '../lib/env.js';

const NOW = new Date('2026-10-24T16:00:00Z');
const good = (id) => ({ id, status: 'succeeded', steps: { offsite: 'ok' } });

test('run ids and cutoffs', () => {
  assert.equal(runTime('20261024T153544Z').toISOString(), '2026-10-24T15:35:44.000Z');
  assert.equal(runTime('nope'), null);
  assert.equal(cutoffId(14, NOW), '20261010T160000Z');
});

test('summarize counts a manifest', () => {
  const s = summarize('20261024T153544Z', {
    status: 'succeeded', trigger: 'manual', startedAt: '2026-10-24T15:35:44Z', finishedAt: '2026-10-24T15:40:00Z',
    firestore: { '(default)': { collections: { users: 34, polls: 3 } } },
    storage: { b: { objects: 872 } }, auth: { users: 34 }, steps: { offsite: 'ok' }, errors: [],
  }, { bytes: 10, objects: 3, hasManifest: true });
  assert.deepEqual([s.status, s.docs, s.collections, s.files, s.users, s.durationSec, s.bytes], ['succeeded', 37, 2, 872, 34, 256, 10]);
  assert.equal(summarize('x', null, { hasManifest: false }).status, 'incomplete');
  assert.equal(summarize('x', null, { hasManifest: true }).status, 'unknown');
  assert.equal(summarize('x', { status: 'running' }).status, 'unknown');
});

test('prunePlan keeps the newest good sets, whatever their age', () => {
  const sets = ['20200101T020000Z', '20200102T020000Z', '20200103T020000Z', '20200104T020000Z', '20200105T020000Z'].map(good);
  sets.push({ id: '20200106T020000Z', status: 'failed' }, { id: '20200107T020000Z', status: 'incomplete' },
    { id: '20200108T020000Z', status: 'unknown' }, { id: '20261024T020000Z', status: 'failed' });
  const plan = prunePlan(sets, { keepMin: 3, keepDays: 14, now: NOW }).map((p) => p.id);
  assert.deepEqual(plan, ['20200107T020000Z', '20200106T020000Z', '20200102T020000Z', '20200101T020000Z']);
  assert.deepEqual(prunePlan(sets, { keepMin: 7, keepDays: 14, now: NOW }).map((p) => p.id), ['20200107T020000Z', '20200106T020000Z']);
});

test('canDelete never goes below the minimum', () => {
  const sets = ['20261020T020000Z', '20261021T020000Z', '20261022T020000Z'].map(good).concat({ id: '20261023T020000Z', status: 'failed' }, { id: '20261019T020000Z', status: 'unknown' });
  assert.equal(canDelete(sets, ['20261020T020000Z'], 3).ok, false);
  assert.equal(canDelete(sets, ['20261020T020000Z'], 2).ok, true);
  assert.equal(canDelete(sets, ['20261020T020000Z', '20261021T020000Z'], 2).ok, false);
  assert.equal(canDelete(sets, ['20261023T020000Z'], 9).ok, true);
  assert.match(canDelete(sets, ['20261019T020000Z'], 1).reason, /never deleted/);
  assert.match(canDelete(sets, ['20990101T000000Z'], 1).reason, /no set/);
});

test('health', () => {
  assert.equal(health([], { now: NOW }).text, 'No backups yet');
  assert.equal(health([good('20261024T020000Z')], { now: NOW }).level, 'ok');
  assert.equal(health([good('20261020T020000Z')], { now: NOW }).level, 'bad');
  assert.equal(health([good('20261024T020000Z'), { id: '20261024T030000Z', status: 'failed' }], { now: NOW }).level, 'warn');
  assert.equal(health([{ id: '20261024T020000Z', status: 'succeeded', steps: {} }], { now: NOW }).text, 'Off-site copy missing');
});

test('backup.env parsing and editing', () => {
  const text = '# c\nPROJECT_ID=foundation-next-app\nPROJECT_LABEL="Foundation Next"\nCHAIN_SECRETS="A B"\nBACKUP_KEEP_DAYS=14 # days\nbad line\n';
  const env = parseEnv(text);
  assert.deepEqual([env.PROJECT_LABEL, env.CHAIN_SECRETS, env.BACKUP_KEEP_DAYS], ['Foundation Next', 'A B', '14']);
  const s = projectSettings(env);
  assert.deepEqual([s.backupBucket, s.keepMinSets, s.keepDays], ['foundation-next-app-backups', 7, 14]);
  assert.equal(parseEnv(setEnvValue(text, 'KEEP_MIN_SETS', '9')).KEEP_MIN_SETS, '9');
  assert.equal(s.storageMode, 'full');
  assert.equal(projectSettings(parseEnv(setEnvValue(text, 'STORAGE_MODE', 'changed'))).storageMode, 'changed');
  assert.equal(parseEnv(setEnvValue(text, 'BACKUP_KEEP_DAYS', '30')).BACKUP_KEEP_DAYS, '30');
  assert.ok(setEnvValue(text, 'BACKUP_KEEP_DAYS', '30').startsWith('# c\n'));
});

test('health: size watch levels are notes, still healthy; 0 turns them off', () => {
  const set = (id, bytes) => ({ id, status: 'succeeded', bytes, steps: { offsite: 'ok' } });
  const sets = [set('20261024T020000Z', 2.4e9), set('20261023T020000Z', 2.3e9)];
  const now = new Date('2026-10-24T05:00:00Z');
  assert.deepEqual(health(sets, { now, maxSetBytes: 2e9 }).notes, ['Newest set is 2.4 GB (watch level 2.0 GB)']);
  assert.equal(health(sets, { now, maxSetBytes: 2e9 }).level, 'ok');
  assert.equal(health(sets, { now, maxSetBytes: 2e9 }).text, 'Healthy');
  assert.deepEqual(health(sets, { now, maxSetBytes: 3e9, maxTotalBytes: 20e9, totalBytes: 21e9 }).notes, ['Backups take 21 GB (watch level 20 GB)']);
  assert.deepEqual(health(sets, { now, maxSetBytes: 0, maxTotalBytes: 0, totalBytes: 99e9 }).notes, []);
});

test('drill lock: busy until the log line ends or the lock expires', async () => {
  const { lockBlocks, endsLock } = await import('../lib/drilllock.js');
  const now = new Date('2026-10-24T22:30:00Z');
  const lock = { project: 'demo-fn', by: 'a@b.c', action: 'rebuild drill', log: 'L1', at: new Date('2026-10-24T22:00:00Z'), until: new Date('2026-10-25T04:00:00Z') };
  assert.match(lockBlocks(lock, now), /busy: rebuild drill of demo-fn, started by a@b\.c 30 min ago/);
  assert.equal(lockBlocks({ ...lock, until: new Date('2026-10-24T22:29:00Z') }, now), null);
  assert.equal(lockBlocks(null, now), null);
  assert.equal(endsLock(lock, 'L1', { action: 'rebuild drill', status: 'succeeded' }), true);
  assert.equal(endsLock(lock, 'L1', { action: 'rebuild drill', status: 'running' }), false);
  assert.equal(endsLock(lock, 'L2', { action: 'rebuild drill', status: 'failed' }), false);
});

test('a paused project is grey and keeps what it was', async () => {
  const { pausedHealth } = await import('../lib/sets.js');
  const h = pausedHealth({ level: 'bad', text: 'Newest good backup is 32h old', goodCount: 14 }, '2026-11-09T10:00:00Z');
  assert.equal(h.level, 'paused');
  assert.equal(h.text, 'Backups paused');
  assert.equal(h.goodCount, 14);
  assert.deepEqual(h.before, { level: 'bad', text: 'Newest good backup is 32h old' });
});
