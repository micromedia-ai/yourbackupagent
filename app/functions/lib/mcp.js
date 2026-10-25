// The MCP connector's tools: the manager app for an AI assistant such as
// Claude. Same rules as the app, because every change goes through the same
// code (`ops`, from index.js): sets are never deleted below a project's
// minimum, one drill at a time, vault copies are never deleted here (that
// needs the person's own Google sign-in in the app), and production is never
// written (a production restore is a command for a person to run).
// Pure logic, Firebase-free.

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS = [
  'YourBackupAgent backs up Firebase projects every night (Firestore, Storage files, Auth users, config) into the project\'s own bucket, with an off-site copy in the vault.',
  'Start with get_overview. A "set" is one nightly backup, id like 20261024T020000Z.',
  'Changes are logged with who asked. delete_sets, prune_sets and wipe_drill_project only show what they would do unless confirm is true: show that to the person and ask before confirming.',
  'A project always keeps at least its minimum of good sets; vault copies cannot be deleted here; production is never restored from here (production_restore_command gives the command for a person to run).',
  'One drill at a time runs in the shared drill project: if a tool says it is busy, wait for that drill to finish (get_log shows it).',
].join(' ');

const project = { type: 'string', description: 'Firebase project id, e.g. foundation-next-app (see get_overview)' };
const runId = { type: 'string', description: 'Backup set id, e.g. 20261024T020000Z (see list_sets)' };
const confirm = { type: 'boolean', description: 'true to do it; otherwise only shows what would happen' };
const read = { readOnlyHint: true };

export const TOOLS = [
  { name: 'get_overview', description: 'Every protected project with its health, set counts and size, the minimum good sets it keeps, plus who holds the shared drill project now.', inputSchema: { type: 'object', properties: {} }, annotations: read },
  { name: 'list_sets', description: 'Backup sets of one project, newest first: status, when, documents, files, users, size, and whether a copy is in the project bucket and in the vault.', inputSchema: { type: 'object', properties: { project, limit: { type: 'integer', description: '1-100, default 20' } }, required: ['project'] }, annotations: read },
  { name: 'get_log', description: 'The action log, newest first: every backup, drill, delete and setting change, with who did it and the result.', inputSchema: { type: 'object', properties: { project: { ...project, description: 'only this project (optional)' }, limit: { type: 'integer', description: '1-100, default 20' } } }, annotations: read },
  { name: 'refresh', description: 'Read every project again from GitHub and its buckets (what the app does each night), then return the overview.', inputSchema: { type: 'object', properties: {} } },
  { name: 'back_up_now', description: 'Start a backup of one project now, in its GitHub Backup workflow. It shows in the log when it finishes (a few minutes).', inputSchema: { type: 'object', properties: { project }, required: ['project'] } },
  { name: 'restore_drill', description: 'Prove the newest set restores: the project\'s Backup workflow restores it into a temporary database inside the project, compares counts, then deletes that database. Production data is not touched.', inputSchema: { type: 'object', properties: { project }, required: ['project'] } },
  { name: 'rebuild_drill', description: 'Rebuild one set into the shared drill project (data, files, users, and the site when the repo has a rebuild-drill workflow). One drill at a time. replace: take the drill project over from a drill of another project.', inputSchema: { type: 'object', properties: { project, run_id: runId, replace: { type: 'boolean' } }, required: ['project', 'run_id'] } },
  { name: 'wipe_drill_project', description: 'Empty the shared drill project after a drill.', inputSchema: { type: 'object', properties: { project: { ...project, description: 'the project whose drill it holds' }, confirm }, required: ['project'] }, annotations: { destructiveHint: true } },
  { name: 'prune_sets', description: 'Delete the sets older than the project keeps, from the project bucket, never below its minimum of good sets. Without confirm: the list it would delete.', inputSchema: { type: 'object', properties: { project, confirm }, required: ['project'] }, annotations: { destructiveHint: true } },
  { name: 'delete_sets', description: 'Delete chosen sets from the project bucket (recoverable for 30 days by soft delete). Refused if fewer than the project\'s minimum of good sets would be left. Vault copies stay. Without confirm: whether it is allowed.', inputSchema: { type: 'object', properties: { project, run_ids: { type: 'array', items: { type: 'string' }, description: 'set ids' }, confirm }, required: ['project', 'run_ids'] }, annotations: { destructiveHint: true } },
  { name: 'production_restore_command', description: 'The command a person runs on their computer to restore a set into production. Nothing is restored from here.', inputSchema: { type: 'object', properties: { project, run_id: runId }, required: ['project', 'run_id'] }, annotations: read },
];

// Firestore Timestamps -> ISO strings, recursively.
export function plain(v) {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

const bound = (n, d = 20) => Math.min(Math.max(Number.isInteger(n) ? n : d, 1), 100);
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
// Errors meant for the caller (HttpsError and plain refusals) carry a code.
const userFacing = (e) => e && typeof e.code === 'string' && e.code !== 'internal';

/**
 * One MCP JSON-RPC message (or batch). ops: { overview(), sets(project, n),
 * log(project, n), refresh(), act(by, data), preview(data),
 * restoreCommand(project, runId) }; `by` names the person and assistant.
 * Returns the reply body, or null for notifications only.
 */
export async function handleMcp(body, { ops, by, onToolCall } = {}) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMcp(m, { ops, by, onToolCall })))).filter(Boolean);
    return out.length ? out : null;
  }
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(body?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = body;
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'yourbackupagent', title: 'YourBackupAgent', version: '1' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const a = params.arguments || {};
      const p = String(a.project || '');
      const ids = Array.isArray(a.run_ids) ? a.run_ids.map(String) : [];
      const handlers = {
        get_overview: () => ops.overview(),
        list_sets: async () => ({ project: p, sets: await ops.sets(p, bound(a.limit)) }),
        get_log: async () => ({ log: await ops.log(p, bound(a.limit)) }),
        refresh: async () => { await ops.refresh(); return ops.overview(); },
        back_up_now: () => ops.act(by, { action: 'backup', project: p }),
        restore_drill: () => ops.act(by, { action: 'drill-here', project: p }),
        rebuild_drill: () => ops.act(by, { action: 'rebuild', project: p, runIds: [String(a.run_id || '')], replace: a.replace === true }),
        wipe_drill_project: () => (a.confirm === true
          ? ops.act(by, { action: 'cleanup-drill', project: p })
          : ops.preview({ action: 'cleanup-drill', project: p })),
        prune_sets: () => (a.confirm === true ? ops.act(by, { action: 'prune', project: p }) : ops.preview({ action: 'prune', project: p })),
        delete_sets: () => (a.confirm === true
          ? ops.act(by, { action: 'delete', project: p, runIds: ids })
          : ops.preview({ action: 'delete', project: p, runIds: ids })),
        production_restore_command: () => ops.restoreCommand(p, String(a.run_id || '')),
      };
      const run = handlers[params.name];
      if (!run) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      const reply = (result, isError = false) => ok({ structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }], ...(isError ? { isError: true } : {}) });
      try {
        const result = plain(await run());
        if (onToolCall) await Promise.resolve(onToolCall({ name: params.name, ok: true })).catch(() => {});
        return reply(result);
      } catch (e) {
        if (onToolCall) await Promise.resolve(onToolCall({ name: params.name, ok: false })).catch(() => {});
        if (userFacing(e)) return reply({ error: e.message }, true);
        console.error('[mcp] tool failed', params.name, e?.message || String(e));
        return reply({ error: `failed: ${String(e?.message || e).slice(0, 300)}` }, true);
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
