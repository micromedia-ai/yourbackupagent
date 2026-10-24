import { useEffect, useState } from 'react';
import { call, logOut } from '../lib/firebase';
import { useDoc, useProjects } from '../lib/data';
import { link } from '../lib/route';
import { useBusy } from '../components/ui';

export function Settings() {
  const access = useDoc<{ emails: string[] }>('config/access');
  const settings = useDoc<{ repos: string[]; defaultMinSets: number }>('config/settings');
  const { rows: projects } = useProjects();
  const [emails, setEmails] = useState('');
  const [repos, setRepos] = useState('');
  const [min, setMin] = useState(7);
  const [perProject, setPerProject] = useState<Record<string, number>>({});
  const { busy, run, banner } = useBusy();

  useEffect(() => { if (access) setEmails((access.emails || []).join('\n')); }, [access]);
  useEffect(() => {
    if (settings !== undefined) {
      setRepos(((settings && settings.repos) || ['dagangilat/foundation-next']).join('\n'));
      setMin((settings && settings.defaultMinSets) || 7);
    }
  }, [settings]);

  const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return (
    <div className="stack narrow">
      <div className="row between"><h1>Settings</h1><button className="btn" onClick={() => logOut()}>Sign out</button></div>
      {banner}
      <section className="panel">
        <h4>Minimum backup sets</h4>
        <p className="small">The newest good sets that are never deleted, by the nightly prune or from this app. Each project keeps its number in its <code>backup-kit/backup.env</code> (<code>KEEP_MIN_SETS</code>), so a change opens a pull request there; it applies once you merge it.</p>
        <div className="tscroll"><table>
          <thead><tr><th>Project</th><th className="n">Now</th><th>Change to</th><th></th></tr></thead>
          <tbody>{(projects || []).map((p) => (
            <tr key={p.projectId}>
              <td>{p.label}</td><td className="n">{p.keepMinSets}</td>
              <td><input type="number" min={1} max={999} id={`min-${p.projectId}`} value={perProject[p.projectId] ?? p.keepMinSets} onChange={(e) => setPerProject({ ...perProject, [p.projectId]: Number(e.target.value) })} /></td>
              <td><button className="btn small" disabled={!!busy || (perProject[p.projectId] ?? p.keepMinSets) === p.keepMinSets} onClick={() => run('min', async () => {
                const r = await call<{ pr: string }>('setMinSets', { project: p.projectId, n: perProject[p.projectId] });
                return { text: 'Pull request opened. Merge it to apply.', link: r.pr };
              })}>Open pull request</button></td>
            </tr>
          ))}</tbody>
        </table></div>
        <label>For newly protected projects <input type="number" id="default-min" min={1} max={999} value={min} onChange={(e) => setMin(Number(e.target.value))} /></label>
        <button className="btn" disabled={!!busy} onClick={() => run('save', async () => { await call('saveSettings', { defaultMinSets: min }); return { text: 'Saved.' }; })}>Save</button>
      </section>
      <section className="panel">
        <h4>Repositories</h4>
        <p className="small">Read on every refresh. A repository with <code>backup-kit/backup.env</code> shows up as a project. <a {...link('/protect')}>Protect a new repository</a> adds it here.</p>
        <textarea id="repos" rows={4} value={repos} onChange={(e) => setRepos(e.target.value)} />
        <button className="btn" disabled={!!busy} onClick={() => run('save', async () => { await call('saveSettings', { repos: lines(repos) }); return { text: 'Saved. Press Refresh now on the overview.' }; })}>Save repositories</button>
      </section>
      <section className="panel">
        <h4>Who can sign in</h4>
        <p className="small">Google accounts, one per line. Everyone else is refused by the app and by the database rules.</p>
        <textarea id="emails" rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} />
        <button className="btn" disabled={!!busy} onClick={() => run('save', async () => { await call('saveSettings', { emails: lines(emails) }); return { text: 'Saved.' }; })}>Save access list</button>
      </section>
    </div>
  );
}
