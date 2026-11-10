import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupArchives, drillResult, archiveRow, newestPerProject } from '../lib/archives.js';

const files = [
  { name: 'archive/harmonize-ai-app/20261110T142307Z/manifest.json', size: 10 },
  { name: 'archive/harmonize-ai-app/20261110T142307Z/firestore/x', size: 100 },
  { name: 'archive/harmonize-ai-app/20261110T142307Z/code/repo.bundle', size: 50 },
  { name: 'archive/harmonize-ai-app/20261110T142307Z/RESTORE.md', size: 5 },
  { name: 'archive/harmonize-ai-app/20261110T142307Z/drill.json', size: 5 },
  { name: 'archive/harmonize-ai-app/20261001T000000Z/manifest.json', size: 10 },
  { name: 'archive/Bad_Id/20261110T142307Z/manifest.json', size: 1 },
  { name: 'archive/ok-project/not-a-run/manifest.json', size: 1 },
  { name: 'runs/20261110T142307Z/manifest.json', size: 1 },
];

test('archives: grouped by project and run, odd paths ignored', () => {
  const g = groupArchives(files);
  assert.deepEqual([...g.keys()].sort(), ['harmonize-ai-app/20261001T000000Z', 'harmonize-ai-app/20261110T142307Z']);
  const a = g.get('harmonize-ai-app/20261110T142307Z');
  assert.equal(a.bytes, 170);
  assert.equal(a.objects, 5);
  assert.ok(a.hasManifest && a.hasRestoreNote && a.hasDrill && a.hasCode);
});

test('archives: drill result is read defensively', () => {
  assert.equal(drillResult(null), null);
  assert.deepEqual(drillResult({ status: 'passed', at: '2026-11-10T15:00:00Z', site: 'x' }), { status: 'passed', at: '2026-11-10T15:00:00Z', site: 'not run', detail: null });
  assert.equal(drillResult({ status: 'weird' }).status, 'unknown');
});

test('archives: rows carry counts; newest per project wins, copies merged', () => {
  const manifest = { status: 'succeeded', startedAt: '2026-11-10T14:23:07Z', firestore: { '(default)': { collections: { users: 3, rooms: 1 } } }, storage: { b: { objects: 2 } }, auth: { users: 3 } };
  const g = groupArchives(files);
  const r1 = archiveRow('yourbackupagent-archive', g.get('harmonize-ai-app/20261110T142307Z'), manifest, { status: 'passed' });
  assert.equal(r1.docs, 4);
  assert.equal(r1.users, 3);
  assert.equal(r1.drill.status, 'passed');
  assert.equal(r1.path, 'gs://yourbackupagent-archive/archive/harmonize-ai-app/20261110T142307Z/');
  const r0 = archiveRow('yourbackupagent-archive', g.get('harmonize-ai-app/20261001T000000Z'), null, null);
  const eu = { ...r1, bucket: 'yourbackupagent-archive-eu' };
  const [n] = newestPerProject([r0, r1, eu]);
  assert.equal(n.id, '20261110T142307Z');
  assert.equal(n.older, 1);
  assert.deepEqual(n.copies.sort(), ['yourbackupagent-archive', 'yourbackupagent-archive-eu']);
});
