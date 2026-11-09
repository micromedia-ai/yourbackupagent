import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthEvents, levels, drillFinished, healthEmail, drillEmail, weeklyEmail, welcomeEmail } from '../lib/alerts.js';
import { setupCommands } from '../lib/protect.js';

const P = (id, level, text = level) => ({ projectId: id, label: id.toUpperCase(), keepMinSets: 7, health: { level, text, goodCount: 8, newestGood: '20261024T020000Z' }, totals: { bytes: 2.5e9 } });

test('health events: worse alerts, back to ok recovers, same is quiet', () => {
  const ev = healthEvents({ a: 'ok', b: 'bad', c: 'warn', d: 'ok' }, [P('a', 'bad'), P('b', 'ok'), P('c', 'warn'), P('d', 'warn'), P('e', 'warn'), P('f', 'ok')]);
  assert.deepEqual(ev.map((e) => [e.kind, e.project.projectId, e.level]), [['alert', 'a', 'bad'], ['recovered', 'b', 'ok'], ['alert', 'd', 'warn'], ['alert', 'e', 'warn']]);
  assert.deepEqual(healthEvents(levels([P('a', 'bad')]), [P('a', 'bad')]), []);
  assert.equal(healthEvents({ a: 'bad' }, [P('a', 'warn')]).length, 0); // better but not ok yet: quiet
});

test('drill finished: only drills, only once, not old history', () => {
  const now = new Date('2026-10-24T20:00:00Z');
  const at = (iso) => ({ toDate: () => new Date(iso) });
  const line = { action: 'rebuild drill', status: 'succeeded', project: 'p', endedAt: at('2026-10-24T19:00:00Z') };
  assert.equal(drillFinished({ ...line, status: 'running' }, line, now).passed, true);
  assert.equal(drillFinished(line, line, now), null);
  assert.equal(drillFinished({ status: 'running' }, { ...line, action: 'delete sets' }, now), null);
  assert.equal(drillFinished(null, { ...line, action: 'email: drill passed' }, now), null); // its own email line: no loop
  assert.equal(drillFinished({ status: 'running' }, { ...line, action: 'wipe drill project' }, now), null);
  assert.equal(drillFinished({ status: 'running' }, { ...line, status: 'running' }, now), null);
  assert.equal(drillFinished(null, { ...line, endedAt: at('2026-10-01T00:00:00Z') }, now), null);
  assert.equal(drillFinished(null, { ...line, status: 'failed' }, now).passed, false);
});

test('emails: subjects, links, no raw html injection', () => {
  const h = healthEmail(healthEvents({}, [P('a', 'bad', 'Newest good backup is 50h old')]), 'https://app');
  assert.match(h.subject, /need attention: A/);
  assert.match(h.html, /https:\/\/app\/projects\/a/);
  assert.match(h.text, /Newest good backup is 50h old/);
  const d = drillEmail({ passed: false, line: { action: 'rebuild drill', project: 'a', by: '<b>x</b>', detail: 'step 3 failed' } }, 'A', 'https://app');
  assert.match(d.subject, /FAILED: A/);
  assert.ok(!d.html.includes('<b>x</b>'));
  const now = new Date('2026-10-24T20:00:00Z');
  const w = weeklyEmail([P('a', 'ok')], { a: [{ id: '20261024T020000Z', status: 'succeeded', inProject: true }, { id: '20261023T020000Z', status: 'failed', inProject: true }, { id: '20261001T020000Z', status: 'succeeded', inProject: true }] }, [], 'https://app', now);
  assert.equal(w.subject, 'Weekly backups: 1 of 2 good (50%) across 1 project');
  assert.match(w.html, /2.5 GB stored/);
  assert.match(welcomeEmail('a@b.c', 'd@e.f', 'https://app').text, /Sign in as a@b.c/);
});

test('setup is one command per repository', () => {
  const c = setupCommands('dagangilat/x');
  assert.equal(c.length, 2);
  assert.match(c[1].cmd, /\.\/onboard\.sh dagangilat\/x$/);
});

test('pausing or resuming a project sends no alert or recovery', () => {
  const p = (level) => [{ projectId: 'demo-fn', health: { level, text: level } }];
  assert.equal(healthEvents({ 'demo-fn': 'bad' }, p('paused')).length, 0);
  assert.equal(healthEvents({ 'demo-fn': 'paused' }, p('ok')).length, 0);
  assert.equal(healthEvents({ 'demo-fn': 'paused' }, p('bad')).length, 0);
  assert.equal(healthEvents({}, p('paused')).length, 0);
});
