import { test } from 'node:test';
import assert from 'node:assert/strict';
import { github, parseTokens } from '../lib/github.js';

test('parseTokens: a plain token and per-owner tokens', () => {
  assert.deepEqual(parseTokens('abc'), [{ owner: null, token: 'abc' }]);
  assert.deepEqual(parseTokens('dagangilat=t1; Micromedia-AI=t2'), [{ owner: 'dagangilat', token: 't1' }, { owner: 'micromedia-ai', token: 't2' }]);
});

function fake(seen, repos = {}) {
  return async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    const path = url.replace(/^https:\/\/api\.github\.com/, '');
    const body = path.startsWith('/user/repos') ? (repos[init.headers.authorization] || []) : { default_branch: 'main' };
    return { status: 200, ok: true, text: async () => JSON.stringify(body) };
  };
}

test('each owner gets its own token; other calls use the first', async () => {
  const seen = [];
  const gh = github('dagangilat=t1;micromedia-ai=t2', fake(seen));
  await gh.repo('micromedia-ai/your-content-creator');
  await gh.repo('dagangilat/herbpulse');
  await gh.repo('someone/else');
  assert.deepEqual(seen.map((s) => s.auth), ['Bearer t2', 'Bearer t1', 'Bearer t1']);
});

test('a plain token is used for everything, as before', async () => {
  const seen = [];
  const gh = github('only', fake(seen));
  await gh.repo('micromedia-ai/x');
  assert.equal(seen[0].auth, 'Bearer only');
});

test('repos() merges what every token sees, once each, newest push first', async () => {
  const seen = [];
  const gh = github('a=t1;b=t2', fake(seen, {
    'Bearer t1': [{ full_name: 'a/one', pushed_at: '2026-01-01' }, { full_name: 'b/two', pushed_at: '2026-03-01' }],
    'Bearer t2': [{ full_name: 'b/two', pushed_at: '2026-03-01' }, { full_name: 'b/three', pushed_at: '2026-02-01' }],
  }));
  const r = await gh.repos();
  assert.deepEqual(r.map((x) => x.full_name), ['b/two', 'b/three', 'a/one']);
});

test('workflow state and pause/resume use the workflow endpoints', async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push(`${init.method} ${url.replace('https://api.github.com', '')}`);
    if (url.endsWith('/backup.yml')) return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'disabled_manually', updated_at: 'x' }) };
    return { ok: true, status: 204, text: async () => '' };
  };
  const gh = github('t', fake);
  assert.deepEqual(await gh.workflowState('o/r', 'backup.yml'), { state: 'disabled_manually', updatedAt: 'x' });
  await gh.setWorkflow('o/r', 'backup.yml', false);
  await gh.setWorkflow('o/r', 'backup.yml', true);
  assert.deepEqual(seen.slice(1), ['PUT /repos/o/r/actions/workflows/backup.yml/disable', 'PUT /repos/o/r/actions/workflows/backup.yml/enable']);
});
