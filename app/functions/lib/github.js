// GitHub REST calls with the app's token (secret GITHUB_TOKEN: a fine-grained
// token for dagangilat's repositories with Contents, Pull requests, Actions
// and Workflows read/write, Secrets read-only, Metadata read).

// GITHUB_API: only for the offline end-to-end test (a fake GitHub).
const API = process.env.GITHUB_API || 'https://api.github.com';

export function github(token, fetchImpl = fetch) {
  async function call(method, path, body) {
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
    // Every repository the token can see, owned by the user.
    async repos() {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await call('GET', `/user/repos?per_page=100&page=${page}&affiliation=owner&sort=pushed`);
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
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
