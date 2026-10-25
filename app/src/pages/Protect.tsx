import { useState } from 'react';
import { call } from '../lib/firebase';
import { Copy, Pill, useBusy } from '../components/ui';
import { SetUpHere } from '../components/SetUpHere';

type Repo = { repo: string; private: boolean; firebaseProject: string; hasKit: boolean; managed: boolean };
type Result = { pr: string; number: number; projectId: string; secret: string; commands: { what: string; cmd: string }[] };

export function Protect() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [pick, setPick] = useState<Repo | null>(null);
  const [label, setLabel] = useState('');
  const [projectId, setProjectId] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const { busy, run, banner } = useBusy();

  const load = () => run('list', async () => { setRepos((await call<{ repos: Repo[] }>('repos')).repos); });
  return (
    <div className="stack narrow">
      <h1>Protect a repository</h1>
      <p>Opens a pull request in the repository with YourBackupAgent (<code>backup-kit/</code> and a daily Backup workflow), filled in from its <code>.firebaserc</code>. Then set it up right here with a Google sign-in, or with one command on your Mac.</p>
      {banner}
      {!repos && <button className="btn primary" disabled={!!busy} onClick={load}>{busy ? 'Reading your repositories…' : 'List my Firebase repositories'}</button>}
      {repos && !result && (
        <section className="panel">
          <h4>Repositories with firebase.json</h4>
          <ul className="repos">
            {repos.map((r) => (
              <li key={r.repo}>
                <label className={`radio ${pick?.repo === r.repo ? 'on' : ''}`}>
                  <input type="radio" name="repo" id={`repo-${r.repo}`} checked={pick?.repo === r.repo} onChange={() => { setPick(r); setProjectId(r.firebaseProject); setLabel(r.repo.split('/')[1].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())); }} />
                  <span><b>{r.repo}</b> <span className="small muted">{r.firebaseProject || 'no .firebaserc project'}</span>{' '}
                    {r.hasKit ? <Pill tone="ok">has backups</Pill> : <Pill tone="bad">not protected</Pill>}{r.managed && <Pill tone="info">in the app</Pill>}</span>
                </label>
              </li>
            ))}
          </ul>
          {pick && (
            <div className="stack">
              <label>Name <input id="label" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
              <label>Firebase project id <input id="project-id" value={projectId} onChange={(e) => setProjectId(e.target.value.trim())} /></label>
              <button className="btn primary" disabled={!!busy || !projectId} onClick={() => run('protect', async () => {
                const r = await call<Result>('protect', { repo: pick.repo, label, projectId });
                setResult(r);
                return { text: `Pull request #${r.number} opened.`, link: r.pr };
              })}>{busy ? 'Opening the pull request…' : pick.hasKit ? 'Add it to the app (and fill in what is missing)' : 'Open the pull request'}</button>
            </div>
          )}
        </section>
      )}
      {result && (
        <section className="panel">
          <SetUpHere repo={pick!.repo} projectId={result.projectId} />
        </section>
      )}
      {result && (
        <details className="panel">
          <summary><b>Or on your Mac</b></summary>
          <p className="small"> The script checks out the pull request, asks you to log in only where it needs to, {result.secret ? <>uses the secret <code>{result.secret}</code> the repository already has, </> : <>makes a GitHub key for the backups (the repository has none yet), </>}sets up the backup bucket, protection and the vault, takes the first backup, lets this app read it, offers a rebuild drill, and at the end offers to merge. It can run again safely.</p>
          <ol className="steps">
            {result.commands.map((c) => <li key={c.cmd}><span>{c.what}</span><Copy text={c.cmd} /></li>)}
          </ol>
          <p className="small">After the merge the Backup workflow runs every night, and the project shows up on the overview after the next refresh.</p>
        </details>
      )}
    </div>
  );
}
