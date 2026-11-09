// GitHub REST calls with the app's token (secret GITHUB_TOKEN: a fine-grained
// token with Contents, Pull requests, Actions and Workflows read/write, Secrets
// read-only, Metadata read).
//
// A fine-grained token reaches one owner only. To protect repos of more than one
// owner (dagangilat and the micromedia-ai organization), GITHUB_TOKEN may hold
// one token per owner: "dagangilat=github_pat_...;micromedia-ai=github_pat_...".
// Calls on /repos/<owner>/... use that owner's token; anything else (and an
// owner without its own token) uses the first one. A plain token works as before.

// GITHUB_API: only for the offline end-to-end test (a fake GitHub).
const API = process.env.GITHUB_API || 'https://api.github.com';

/** "owner=token;owner2=token2" or a plain token -> [{ owner, token }] (owner null for a plain token). */
export function parseTokens(spec) {
  const parts = String(spec || '').split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  return parts.map((p) => {
    const m = p.match(/^([\w.-]+)=(.+)$/);
    return m ? { owner: m[1].toLowerCase(), token: m[2].trim() } : { owner: null, token: p };
  });
}

export function github(tokenSpec, fetchImpl = fetch) {
  const tokens = parseTokens(tokenSpec);
  const fallback = tokens[0] ? tokens[0].token : '';
  function tokenFor(path) {
    const m = path.match(/^\/repos\/([^/]+)\//);
    const t = m && tokens.find((x) => x.owner === m[1].toLowerCase());
    return t ? t.token : fallback;
  }
  async function call(method, path, body, token = tokenFor(path)) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path}: ${res.status} ${data && data.message ? data.message : ''}`.trim());
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function fileText(repo, path, ref) {
    try {
      const f = await call('GET', `/repos/${repo}/contents/${encodePath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      return { text: Buffer.from(f.content || '', 'base64').toString('utf8'), sha: f.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  return {
    call,
    fileText,
    repo: (repo) => call('GET', `/repos/${repo}`),
    // Every path on the default branch (files and folders); [] for an empty repo.
    async paths(repo) {
      const { default_branch: b } = await call('GET', `/repos/${repo}`);
      const t = await call('GET', `/repos/${repo}/git/trees/${encodeURIComponent(b)}?recursive=1`).catch((e) => (e.status === 404 || e.status === 409 ? { tree: [] } : Promise.reject(e)));
      return (t.tree || []).map((x) => x.path);
    },
    // Every repository the tokens can see, owned by the user or by an organization (one list, newest push first).
    async repos() {
      const out = [];
      const seen = new Set();
      for (const { token } of tokens.length ? tokens : [{ token: '' }]) {
        for (let page = 1; page <= 10; page++) {
          const batch = await call('GET', `/user/repos?per_page=100&page=${page}&affiliation=owner,organization_member&sort=pushed`, undefined, token);
          for (const r of batch) if (!seen.has(r.full_name)) { seen.add(r.full_name); out.push(r); }
          if (batch.length < 100) break;
        }
      }
      return out.sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')));
    },
    dispatch: (repo, workflow, ref, inputs) =>
      call('POST', `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs }),
    runs: (repo, workflow, n = 20) =>
      call('GET', `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${n}`)
        .then((r) => r.workflow_runs || [])
        .catch((e) => (e.status === 404 ? [] : Promise.reject(e))),
    secretNames: (repo) =>
      call('GET', `/repos/${repo}/actions/secrets?per_page=100`).then((r) => (r.secrets || []).map((s) => s.name)),
    // One commit with several files on a new branch, then a pull request.
    async pullRequest(repo, { branch, title, body, files, message }) {
      const info = await call('GET', `/repos/${repo}`);
      const base = info.default_branch;
      const head = await call('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
      const baseCommit = await call('GET', `/repos/${repo}/git/commits/${head.object.sha}`);
      const tree = await call('POST', `/repos/${repo}/git/trees`, {
        base_tree: baseCommit.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: f.executable ? '100755' : '100644', type: 'blob', content: f.content })),
      });
      const commit = await call('POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [head.object.sha] });
      try {
        await call('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
      } catch (e) {
        if (e.status !== 422) throw e;
        await call('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: true });
      }
      const open = await call('GET', `/repos/${repo}/pulls?head=${repo.split('/')[0]}:${encodeURIComponent(branch)}&state=open`);
      if (open.length) return open[0];
      return call('POST', `/repos/${repo}/pulls`, { title, body, head: branch, base });
    },
  };
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}
