import { useEffect, useState } from 'react';
import { call, logOut } from '../lib/firebase';
import { useDoc, useProjects, useRequests } from '../lib/data';
import { tsDate, when } from '../lib/format';
import { link } from '../lib/route';
import { useBusy } from '../components/ui';

export function Settings() {
  const access = useDoc<{ emails: string[] }>('config/access');
  const settings = useDoc<{ repos: string[]; defaultMinSets: number; sizeWarnSetGB?: number; sizeWarnTotalGB?: number }>('config/settings');
  const { rows: projects } = useProjects();
  const [emails, setEmails] = useState('');
  const [repos, setRepos] = useState('');
  const [min, setMin] = useState(7);
  const [watch, setWatch] = useState({ set: 2, total: 20 });
  const [perProject, setPerProject] = useState<Record<string, number>>({});
  const { busy, run, banner } = useBusy();
  const { rows: requests } = useRequests();
  const notify = useDoc<{ health?: boolean; recoveries?: boolean; drills?: boolean; weekly?: boolean; recipients?: string[] }>('config/notify');
  const [invitee, setInvitee] = useState('');
  const [n, setN] = useState({ health: true, recoveries: true, drills: true, weekly: true });
  const [recips, setRecips] = useState<string[] | null>(null);
  useEffect(() => {
    if (notify !== undefined) {
      setN({ health: notify?.health ?? true, recoveries: notify?.recoveries ?? true, drills: notify?.drills ?? true, weekly: notify?.weekly ?? true });
      setRecips(notify?.recipients ?? null);
    }
  }, [notify]);
  const everyone = access?.emails || [];
  const chosen = recips ?? everyone;

  useEffect(() => { if (access) setEmails((access.emails || []).join('\n')); }, [access]);
  useEffect(() => {
    if (settings !== undefined) {
      setRepos(((settings && settings.repos) || ['dagangilat/foundation-next']).join('\n'));
      setMin((settings && settings.defaultMinSets) || 7);
      setWatch({ set: settings?.sizeWarnSetGB ?? 2, total: settings?.sizeWarnTotalGB ?? 20 });
    }
  }, [settings]);

  const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return (
    <div className="stack narrow">
      <div className="row between"><h1>Settings</h1><button className="btn" onClick={() => logOut()}>Sign out</button></div>
      {banner}
      <section className="panel">
        <h4>Email alerts</h4>
        <p className="small">Sent from backups@plantagoai.com through Resend. Checked after the nightly refresh at 05:30 UTC; drill results go out as soon as a drill ends.</p>
        <div className="checks">
          {([['health', 'A project needs attention (failed, too old, off-site copy missing, past its size watch level)'], ['recoveries', 'It is healthy again'], ['drills', 'A rebuild or restore drill passed or failed'], ['weekly', 'A summary every Monday']] as const).map(([key, text]) => (
            <label key={key} className="check"><input type="checkbox" id={`n-${key}`} checked={n[key]} onChange={(e) => setN({ ...n, [key]: e.target.checked })} /> {text}</label>
          ))}
        </div>
        <span className="small muted">Who gets them</span>
        <div className="checks">
          {everyone.map((e) => (
            <label key={e} className="check"><input type="checkbox" checked={chosen.includes(e)} onChange={(ev) => setRecips(ev.target.checked ? [...chosen, e] : chosen.filter((x) => x !== e))} /> {e}</label>
          ))}
        </div>
        <div className="row wrap">
          <button className="btn primary" disabled={!!busy} onClick={() => run('notify', async () => { await call('saveNotify', { ...n, recipients: chosen }); return { text: 'Email alerts saved.' }; })}>Save</button>
          <button className="btn" disabled={!!busy} onClick={() => run('test', async () => { await call('testEmail'); return { text: 'Sent you this week\'s summary as a test.' }; })}>Send me a test</button>
          <button className="btn" disabled={!!busy} onClick={() => run('check', async () => {
            const r = await call<{ events: { kind: string; project: string }[] }>('alertsNow');
            return { text: r.events.length ? `Emailed: ${r.events.map((e) => `${e.project} ${e.kind === 'alert' ? 'needs attention' : 'recovered'}`).join(', ')}.` : 'Checked: nothing changed since the last check, so no email.' };
          })}>Check now</button>
        </div>
      </section>
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
        <h4>Backup size watch</h4>
        <p className="small">Every set is a full copy (database and all media), so storage grows with the project. A project past either level shows as needing attention and, with email alerts on, you get an email. 0 turns a level off.</p>
        <div className="row wrap">
          <label>One set, newest (GB) <input type="number" id="watch-set" min={0} step={0.5} value={watch.set} onChange={(e) => setWatch({ ...watch, set: Number(e.target.value) })} /></label>
          <label>All sets of a project, here and in the vault (GB) <input type="number" id="watch-total" min={0} step={1} value={watch.total} onChange={(e) => setWatch({ ...watch, total: Number(e.target.value) })} /></label>
        </div>
        <button className="btn" disabled={!!busy} onClick={() => run('watch', async () => { await call('saveSettings', { sizeWarnSetGB: watch.set, sizeWarnTotalGB: watch.total }); return { text: 'Saved. It applies from the next refresh.' }; })}>Save</button>
      </section>
      <Connector />
      <section className="panel">
        <h4>Repositories</h4>
        <p className="small">Read on every refresh. A repository with <code>backup-kit/backup.env</code> shows up as a project. <a {...link('/protect')}>Protect a new repository</a> adds it here.</p>
        <textarea id="repos" rows={4} value={repos} onChange={(e) => setRepos(e.target.value)} />
        <button className="btn" disabled={!!busy} onClick={() => run('save', async () => { await call('saveSettings', { repos: lines(repos) }); return { text: 'Saved. Press Refresh now on the overview.' }; })}>Save repositories</button>
      </section>
      <section className="panel">
        <h4>Invite someone</h4>
        <p className="small">Invite only. Adds the Google account to the list below and emails them a link.</p>
        <div className="row wrap">
          <input id="invite-email" type="email" placeholder="name@gmail.com" value={invitee} onChange={(e) => setInvitee(e.target.value)} />
          <button className="btn primary" disabled={!!busy || !invitee} onClick={() => run('invite', async () => {
            const r = await call<{ emailed: boolean }>('invite', { email: invitee });
            setInvitee('');
            return { text: r.emailed ? 'Invited and emailed.' : 'Invited (email is off, so tell them yourself).' };
          })}>Invite</button>
        </div>
        {requests && requests.length > 0 && (
          <>
            <span className="small muted">Asking for access</span>
            <ul className="requests">
              {requests.map((r) => (
                <li key={r.id}>
                  <span><b>{r.email}</b>{r.name ? ` (${r.name})` : ''} <span className="small muted">{when(tsDate(r.at))}</span>{r.note && <><br /><span className="small">“{r.note}”</span></>}</span>
                  <span className="row">
                    <button className="btn small primary" disabled={!!busy} onClick={() => run('decide', async () => { await call('decideAccess', { email: r.email, approve: true }); return { text: `${r.email} can sign in now, and got an email.` }; })}>Approve</button>
                    <button className="btn small" disabled={!!busy} onClick={() => run('decide', async () => { await call('decideAccess', { email: r.email, approve: false }); return { text: `Declined ${r.email}.` }; })}>Decline</button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
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

type Grant = { id: string; clientName: string; email: string; createdAt: string | null; lastUsedAt: string | null };

// The MCP connector: its address, and the assistants signed in to it.
function Connector() {
  const [data, setData] = useState<{ grants: Grant[]; url: string } | null>(null);
  const { busy, run, banner } = useBusy();
  const load = () => call<{ grants: Grant[]; url: string }>('mcpGrants', { action: 'list' }).then(setData).catch(() => setData({ grants: [], url: `${location.origin}/mcp` }));
  useEffect(() => { void load(); }, []);
  const url = data?.url || `${location.origin}/mcp`;
  return (
    <section className="panel" id="connector">
      <h4>AI assistant connector</h4>
      <p className="small">Use YourBackupAgent from Claude: in Claude, Settings → Connectors → Add custom connector, paste this address, then sign in here with Google and tap Allow. Only people on the access list can connect. It has the same rules as this app, and everything it does is in the log.</p>
      <div className="code"><pre id="connector-url">{url}</pre></div>
      {banner}
      {data && data.grants.length === 0 && <p className="small muted">No assistant is connected.</p>}
      {data && data.grants.length > 0 && (
        <ul className="requests grants">
          {data.grants.map((g) => (
            <li key={g.id}>
              <span><b>{g.clientName}</b> as {g.email} <span className="small muted">connected {when(g.createdAt ? new Date(g.createdAt) : null)}, last used {when(g.lastUsedAt ? new Date(g.lastUsedAt) : null)}</span></span>
              <button className="btn small" disabled={!!busy} onClick={() => run('grant', async () => { await call('mcpGrants', { action: 'remove', id: g.id }); await load(); return { text: `Disconnected ${g.clientName}.` }; })}>Disconnect</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
