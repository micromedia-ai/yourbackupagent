// The MCP connector: OAuth sign-in (register, consent, code + PKCE,
// refresh, disconnect, access list) and the tools' guard rails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createOAuth, redirectAllowed, authServerMetadata, resourceMetadata } from '../lib/oauth.js';
import { handleMcp, TOOLS, plain } from '../lib/mcp.js';

function memStore() {
  const cols = new Map();
  const col = (c) => { if (!cols.has(c)) cols.set(c, new Map()); return cols.get(c); };
  return {
    cols,
    async get(c, id) { return col(c).get(id) || null; },
    async set(c, id, d) { col(c).set(id, { ...d }); },
    async update(c, id, d) { if (col(c).has(id)) col(c).set(id, { ...col(c).get(id), ...d }); },
    async take(c, id) { const d = col(c).get(id) || null; col(c).delete(id); return d; },
    async delete(c, id) { col(c).delete(id); },
    async query(c, f, v) { return [...col(c)].filter(([, d]) => !f || d[f] === v).map(([id, data]) => ({ id, data })); },
  };
}

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function setup() {
  const store = memStore();
  const allowed = new Set(['dagan.gilat@gmail.com']);
  let t = 1_000_000;
  const oauth = createOAuth({ store, now: () => t, random: () => randomBytes(32).toString('base64url'), isAllowed: async (e) => allowed.has(e) });
  return { store, allowed, oauth, tick: (ms) => { t += ms; } };
}

async function connect(oauth, email = 'Dagan.Gilat@gmail.com') {
  const reg = await oauth.register({ client_name: 'Claude', redirect_uris: [REDIRECT] });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = { clientId: reg.client_id, redirectUri: REDIRECT, state: 'st8', codeChallenge: challenge, codeChallengeMethod: 'S256' };
  const { redirect } = await oauth.approve({ ...params, user: { uid: 'u1', email } });
  const back = new URL(redirect);
  assert.equal(back.searchParams.get('state'), 'st8');
  return { clientId: reg.client_id, verifier, code: back.searchParams.get('code') };
}

test('discovery: /mcp is protected by this app, sign-in at /connect-ai', () => {
  const r = resourceMetadata('https://yourbackupagent-app.web.app');
  assert.equal(r.resource, 'https://yourbackupagent-app.web.app/mcp');
  const m = authServerMetadata('https://yourbackupagent-app.web.app');
  assert.equal(m.authorization_endpoint, 'https://yourbackupagent-app.web.app/connect-ai');
  assert.equal(m.token_endpoint, 'https://yourbackupagent-app.web.app/mcp/oauth/token');
  assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
});

test('only Claude and local apps may register', async () => {
  const { oauth } = setup();
  assert.equal(redirectAllowed(REDIRECT), true);
  assert.equal(redirectAllowed('http://localhost:33418/cb'), true);
  assert.equal(redirectAllowed('https://claude.ai.evil.example/cb'), false);
  await assert.rejects(oauth.register({ redirect_uris: ['https://evil.example/cb'] }), /not allowed/);
});

test('sign in, use, refresh, disconnect; codes and refresh tokens work once', async () => {
  const { oauth, store } = setup();
  const { clientId, verifier, code } = await connect(oauth);
  await assert.rejects(oauth.token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'x'.repeat(43) }), /code_verifier/);
  const c2 = await connect(oauth);
  const tok = await oauth.token({ grant_type: 'authorization_code', code: c2.code, client_id: c2.clientId, redirect_uri: REDIRECT, code_verifier: c2.verifier });
  assert.match(tok.access_token, /^ybat_/);
  await assert.rejects(oauth.token({ grant_type: 'authorization_code', code: c2.code, client_id: c2.clientId, redirect_uri: REDIRECT, code_verifier: c2.verifier }), /invalid or expired/);
  const who = await oauth.verify(tok.access_token);
  assert.equal(who.email, 'dagan.gilat@gmail.com', 'email kept lower case, as on the access list');
  const again = await oauth.token({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: c2.clientId });
  await assert.rejects(oauth.token({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: c2.clientId }), /invalid or expired/);
  const grants = await oauth.listGrants();
  assert.equal(grants.length, 1);
  await oauth.removeGrant(grants[0].id);
  assert.equal(await oauth.verify(again.access_token), null);
  assert.equal([...store.cols.get('mcp/oauth/tokens').values()].length, 0);
  assert.ok(verifier);
});

test('a token stops working when its person leaves the access list, and after an hour', async () => {
  const { oauth, allowed, tick } = setup();
  const c = await connect(oauth);
  const tok = await oauth.token({ grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: REDIRECT, code_verifier: c.verifier });
  assert.ok(await oauth.verify(tok.access_token));
  tick(3600 * 1000 + 1);
  assert.equal(await oauth.verify(tok.access_token), null);
  const fresh = await oauth.token({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: c.clientId });
  allowed.clear();
  assert.equal(await oauth.verify(fresh.access_token), null);
  await assert.rejects(oauth.token({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: c.clientId }), /access list/);
});

test('someone off the list gets no token', async () => {
  const { oauth } = setup();
  const c = await connect(oauth, 'stranger@example.com');
  await assert.rejects(oauth.token({ grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: REDIRECT, code_verifier: c.verifier }), /access list/);
});

function fakeOps() {
  const calls = [];
  const refusal = (msg) => Object.assign(new Error(msg), { code: 'failed-precondition' });
  return {
    calls,
    overview: async () => ({ projects: [{ projectId: 'demo-fn', refreshedAt: { toDate: () => new Date('2026-10-24T05:30:00Z') } }] }),
    sets: async () => [],
    log: async () => [],
    refresh: async () => { calls.push(['refresh']); },
    act: async (by, d) => { calls.push(['act', by, d]); if (d.action === 'delete') throw refusal('Not allowed: would leave 2 good sets'); return { ok: true }; },
    preview: async (d) => { calls.push(['preview', d]); return { preview: true }; },
    restoreCommand: async () => ({ command: 'x' }),
  };
}

const callTool = (ops, name, args) => handleMcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, { ops, by: 'dagan.gilat@gmail.com via Claude' });

test('MCP: initialize, tools/list, read tools and Timestamps', async () => {
  const ops = fakeOps();
  const init = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { ops });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /never restored from here/);
  const list = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ops });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.equal(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, { ops }), null);
  const ov = await callTool(ops, 'get_overview', {});
  assert.equal(ov.result.structuredContent.projects[0].refreshedAt, '2026-10-24T05:30:00.000Z');
  assert.equal(plain(null), null);
});

test('MCP: destructive tools only preview without confirm; changes carry who asked', async () => {
  const ops = fakeOps();
  for (const name of ['prune_sets', 'delete_sets', 'wipe_drill_project']) {
    const r = await callTool(ops, name, { project: 'demo-fn', run_ids: ['20261024T020000Z'] });
    assert.equal(r.result.structuredContent.preview, true, name);
  }
  assert.ok(ops.calls.every((c) => c[0] === 'preview'));
  await callTool(ops, 'prune_sets', { project: 'demo-fn', confirm: true });
  await callTool(ops, 'rebuild_drill', { project: 'demo-fn', run_id: '20261024T020000Z' });
  const acts = ops.calls.filter((c) => c[0] === 'act');
  assert.deepEqual(acts.map((c) => c[2].action), ['prune', 'rebuild']);
  assert.equal(acts[1][2].replace, false);
  assert.ok(acts.every((c) => c[1] === 'dagan.gilat@gmail.com via Claude'));
});

test('MCP: a refusal comes back as a tool error with its reason', async () => {
  const r = await callTool(fakeOps(), 'delete_sets', { project: 'demo-fn', run_ids: ['20261024T020000Z'], confirm: true });
  assert.equal(r.result.isError, true);
  assert.match(r.result.structuredContent.error, /would leave 2 good sets/);
  const unknown = await callTool(fakeOps(), 'drop_database', {});
  assert.equal(unknown.error.code, -32602);
});
