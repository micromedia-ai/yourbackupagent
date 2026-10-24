import { Fragment, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { call, storageToken } from '../lib/firebase';
import { useDoc, useProjects, useSets, type BackupSet, type Project } from '../lib/data';
import { bytes, monthlyCost, num, runDate, tsDate, when, ago } from '../lib/format';
import { deleteVaultSet } from '../lib/vault';
import { link } from '../lib/route';
import { Copy, Dialog, Pill, statusTone, useBusy } from '../components/ui';
import { Line } from '../components/charts';
import { DrillSlot } from './Overview';
// The same rules the API and the kit apply.
import { canDelete } from '../../functions/lib/sets.js';

type Where = 'project' | 'vault' | 'both';

export function ProjectPage({ projectId, user }: { projectId: string; user: User }) {
  const { rows: projects } = useProjects();
  const { rows: sets, error } = useSets(projectId);
  const p = (projects || []).find((x) => x.projectId === projectId);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<null | { kind: 'delete' } | { kind: 'restore'; set: BackupSet } | { kind: 'prune' }>(null);
  const [open, setOpen] = useState('');
  const { busy, run, banner } = useBusy();
  const slot = useDoc<{ labels: Record<string, string> }>('drill/slot');

  if (!projects) return <p className="muted">Loading…</p>;
  if (!p) return <p>No project {projectId}. <a {...link('/')}>Overview</a></p>;
  const all = sets || [];
  const good = all.filter((s) => s.status === 'succeeded');
  const holdsDrill = slot?.labels?.['drill-of'] === p.projectId;

  const toggle = (id: string) => setSel((old) => { const n = new Set(old); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const act = (label: string, data: object, text: string) => run(label, async () => {
    const r = await call<{ link?: string }>('act', { project: p.projectId, ...data });
    return { text, link: r.link };
  });

  return (
    <div className="stack">
      <div className="row between wrap">
        <div>
          <a className="small" {...link('/')}>← Overview</a>
          <h1>{p.label}</h1>
          <span className="small muted"><code>{p.projectId}</code> · <a href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer">{p.repo}</a> · kit {p.kitRef || '?'} · read {ago(tsDate(p.refreshedAt))}</span>
        </div>
        <div className="row wrap">
          <button className="btn primary" disabled={!!busy} onClick={() => act('backup', { action: 'backup' }, 'Backup started in GitHub. It shows up here when it finishes (press Refresh).')}>Back up now</button>
          <button className="btn" disabled={!!busy} onClick={() => act('drill', { action: 'drill-here' }, 'Restore drill of the newest set started in GitHub.')}>Restore drill</button>
          {holdsDrill && <button className="btn" disabled={!!busy} onClick={() => act('wipe', { action: 'cleanup-drill' }, 'Wiping the drill project. The log shows when it is done.')}>Wipe drill project</button>}
        </div>
      </div>
      {banner}
      {busy && <p className="muted">Working: {busy}…</p>}
      <div className="row wrap">
        <Pill tone={statusTone(p.health?.level || 'bad') as any}>{p.health?.text || 'Not read yet'}</Pill>
        <Pill tone="info">Keeps at least {p.keepMinSets} good sets</Pill>
        <Pill tone="muted">Others {p.keepDays} days here, {p.offsiteKeepDays} in the vault</Pill>
        {p.offsiteBucket ? <Pill tone="ok">Off-site: {p.offsiteBucket}</Pill> : <Pill tone="warn">No off-site copy</Pill>}
      </div>
      <DrillSlot />
      {p.errors?.map((e) => <p key={e} className="banner bad">{e}</p>)}
      {error && <p className="banner bad">{error}</p>}

      <section className="panel">
        <div className="row between wrap">
          <h4>Backup sets ({all.length}; {good.length} good)</h4>
          <div className="row wrap">
            {(p.prunePreview?.length || 0) > 0 && <button className="btn small" onClick={() => setDlg({ kind: 'prune' })}>Prune {p.prunePreview!.length} old</button>}
            <button className="btn small danger" disabled={sel.size === 0} onClick={() => setDlg({ kind: 'delete' })}>Delete {sel.size || ''} selected</button>
          </div>
        </div>
        <div className="tscroll">
          <table className="sets">
            <thead><tr><th></th><th>Set</th><th>When</th><th>Status</th><th className="n">Documents</th><th className="n">Files</th><th className="n">Users</th><th className="n">Size</th><th>Copies</th><th></th></tr></thead>
            <tbody>
              {all.map((s) => (
                <Fragment key={s.id}>
                  <tr className={sel.has(s.id) ? 'selected' : ''}>
                    <td><input type="checkbox" id={`sel-${s.id}`} aria-label={`select ${s.id}`} checked={sel.has(s.id)} onChange={() => toggle(s.id)} /></td>
                    <td><button className="linkish mono" onClick={() => setOpen(open === s.id ? '' : s.id)}>{s.id}</button></td>
                    <td>{when(runDate(s.id))}{s.trigger ? <span className="muted"> · {s.trigger}</span> : null}</td>
                    <td><Pill tone={statusTone(s.status) as any}>{s.status === 'succeeded' ? 'good' : s.status}</Pill></td>
                    <td className="n">{num(s.docs)}</td><td className="n">{num(s.files)}</td><td className="n">{num(s.users)}</td>
                    <td className="n">{bytes(s.bytes)}</td>
                    <td>{[s.inProject && 'project', s.inVault && 'vault'].filter(Boolean).join(' + ')}</td>
                    <td>{s.status === 'succeeded' && <button className="btn small" onClick={() => setDlg({ kind: 'restore', set: s })}>Restore…</button>}</td>
                  </tr>
                  {open === s.id && (
                    <tr className="details"><td></td><td colSpan={9}>
                      <div className="small">Steps: {Object.entries(s.steps || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}
                        {s.durationSec != null && <> · took {Math.round(s.durationSec / 60)} min</>}</div>
                      {(s.errors || []).map((e) => <div key={e} className="small bad-text">{e}</div>)}
                      {s.status === 'succeeded' && <div className="only-phone"><button className="btn small" onClick={() => setDlg({ kind: 'restore', set: s })}>Restore…</button></div>}
                      {s.vault && s.project && s.vault.bytes !== s.project.bytes && <div className="small muted">Vault copy {bytes(s.vault.bytes)} ({s.vault.status})</div>}
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {sets && all.length === 0 && <p className="muted">No backup sets found yet.</p>}
      </section>

      <div className="split">
        <section className="panel"><h4>Documents per good backup</h4>
          <Line labels={good.slice().reverse().map((s) => when(runDate(s.id)))} values={good.slice().reverse().map((s) => s.docs || 0)} unit={(v) => num(Math.round(v))} />
        </section>
        <section className="panel"><h4>Storage</h4>
          <p>{bytes(p.totals?.bytes || 0)} in {p.totals?.inProject || 0} project and {p.totals?.inVault || 0} vault copies: about <b>${monthlyCost(p.totals?.bytes || 0).toFixed(2)} a month</b>.</p>
          <p className="small muted">Deleted sets stay recoverable for 30 days (bucket soft delete), and count toward storage until then.</p>
        </section>
      </div>

      {dlg?.kind === 'delete' && <DeleteDialog p={p} sets={all} ids={[...sel]} user={user} onClose={() => setDlg(null)} onDone={() => setSel(new Set())} />}
      {dlg?.kind === 'prune' && <PruneDialog p={p} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'restore' && <RestoreDialog p={p} set={dlg.set} holder={slot?.labels?.['drill-of'] || ''} newestGood={good[0]?.id} onClose={() => setDlg(null)} />}
    </div>
  );
}

function DeleteDialog({ p, sets, ids, user, onClose, onDone }: { p: Project; sets: BackupSet[]; ids: string[]; user: User; onClose: () => void; onDone: () => void }) {
  const [where, setWhere] = useState<Where>('project');
  const [typed, setTyped] = useState('');
  const [progress, setProgress] = useState('');
  const { busy, run, banner } = useBusy();
  const word = `delete ${ids.length}`;
  const projectSets = useMemo(() => sets.filter((s) => s.inProject).map((s) => s.project!).filter(Boolean), [sets]);
  const vaultSets = useMemo(() => sets.filter((s) => s.inVault).map((s) => s.vault!).filter(Boolean), [sets]);
  const inP = ids.filter((id) => projectSets.some((s) => s.id === id));
  const inV = ids.filter((id) => vaultSets.some((s) => s.id === id));
  const vP = inP.length ? canDelete(projectSets, inP, p.keepMinSets) : { ok: true, goodAfter: projectSets.filter((s) => s.status === 'succeeded').length };
  const vV = inV.length ? canDelete(vaultSets, inV, p.keepMinSets) : { ok: true, goodAfter: vaultSets.filter((s) => s.status === 'succeeded').length };
  const wantP = where !== 'vault', wantV = where !== 'project';
  const blocked = (wantP && !vP.ok && vP.reason) || (wantV && !vV.ok && vV.reason) || (wantV && !p.offsiteBucket && 'this project has no vault copy');

  const go = () => run('delete', async () => {
    let done: string[] = [];
    if (wantP && inP.length) {
      setProgress('Deleting the project copies…');
      done = (await call<{ deleted: string[] }>('act', { action: 'delete', project: p.projectId, runIds: inP })).deleted;
    }
    if (wantV && inV.length) {
      setProgress('Google asks you to allow storage access…');
      const token = await storageToken(user);
      const { logId } = await call<{ logId: string }>('logVault', { project: p.projectId, runIds: inV, phase: 'start' });
      let files = 0;
      try {
        for (const id of inV) {
          setProgress(`Deleting the vault copy of ${id}…`);
          files += await deleteVaultSet(token, p.offsiteBucket, id, (n) => setProgress(`Deleting the vault copy of ${id}: ${n} files…`));
        }
        await call('logVault', { project: p.projectId, runIds: inV, phase: 'end', logId, result: 'succeeded', detail: `deleted ${inV.length} vault set(s), ${files} files, from gs://${p.offsiteBucket}; recoverable for 30 days (soft delete)` });
      } catch (e: any) {
        await call('logVault', { project: p.projectId, runIds: inV, phase: 'end', logId, result: 'failed', detail: e.message }).catch(() => {});
        throw e;
      }
    }
    setProgress('');
    onDone();
    return { text: `Deleted ${done.length} project and ${wantV ? inV.length : 0} vault copies.` };
  });

  return (
    <Dialog title={`Delete ${ids.length} set${ids.length > 1 ? 's' : ''} of ${p.label}?`} onClose={onClose}>
      <p className="small">{ids.join(', ')}</p>
      <div className="radios">
        {(['project', 'both', 'vault'] as Where[]).map((w) => (
          <label key={w} className={`radio ${where === w ? 'on' : ''}`}>
            <input type="radio" name="where" id={`where-${w}`} checked={where === w} onChange={() => setWhere(w)} />
            <span>{w === 'project' ? `Project bucket only (${inP.length})` : w === 'both' ? `Project bucket and vault (${inP.length} + ${inV.length})` : `Vault only (${inV.length})`}
              {w !== 'project' && <span className="small muted"> · uses your own Google sign-in</span>}</span>
          </label>
        ))}
      </div>
      <p className="small">After this: {wantP ? `${vP.ok ? vP.goodAfter : '—'} good sets in the project bucket` : ''}{wantP && wantV ? ', ' : ''}{wantV ? `${vV.ok ? vV.goodAfter : '—'} in the vault` : ''} (minimum {p.keepMinSets}). Deleted files stay recoverable for 30 days.</p>
      {blocked ? <p className="banner bad">Not allowed: {blocked}</p> : (
        <>
          <label className="small">Type <code>{word}</code> to confirm <input id="confirm-delete" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></label>
          <button className="btn danger" disabled={typed !== word || !!busy} onClick={go}>{busy ? 'Deleting…' : `Delete ${ids.length}`}</button>
        </>
      )}
      {progress && <p className="small muted">{progress}</p>}
      {banner}
    </Dialog>
  );
}

function PruneDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const { busy, run, banner } = useBusy();
  const plan = p.prunePreview || [];
  return (
    <Dialog title={`Prune ${plan.length} old set(s) of ${p.label}`} onClose={onClose}>
      <p className="small">The same rule the nightly backup applies: the newest {p.keepMinSets} good sets always stay; other good sets go after {p.keepDays} days, failed or incomplete ones after 3 days. Project bucket only.</p>
      <ul className="small">{plan.map((x) => <li key={x.id}><code>{x.id}</code> · {x.why}</li>)}</ul>
      <button className="btn danger" disabled={!!busy} onClick={() => run('prune', async () => {
        const r = await call<{ deleted: string[] }>('act', { action: 'prune', project: p.projectId });
        return { text: `Deleted ${r.deleted.length} set(s).` };
      })}>{busy ? 'Pruning…' : 'Prune now'}</button>
      {banner}
    </Dialog>
  );
}

function RestoreDialog({ p, set, holder, newestGood, onClose }: { p: Project; set: BackupSet; holder: string; newestGood?: string; onClose: () => void }) {
  const [target, setTarget] = useState<'drill' | 'temp' | 'prod'>('drill');
  const [replace, setReplace] = useState(false);
  const { busy, run, banner } = useBusy();
  const other = holder && holder !== p.projectId;
  const prodCmd = `cd ~/path/to/${p.repo.split('/')[1]}\nbackup-kit/backup.sh run          # a fresh backup first\nbackup-kit/backup.sh restore --to ${p.projectId} --run ${set.id}${set.inProject ? ` --from gs://${p.backupBucket}/runs` : ''}`;
  return (
    <Dialog title={`Restore ${set.id}`} onClose={onClose}>
      <p className="small muted">{p.label} · {num(set.docs)} documents · {num(set.files)} files · {num(set.users)} users</p>
      <div className="radios">
        <label className={`radio ${target === 'drill' ? 'on' : ''}`}><input type="radio" name="target" id="t-drill" checked={target === 'drill'} onChange={() => setTarget('drill')} disabled={!set.inVault} />
          <span><b>Into the drill project</b> <span className="small muted">({p.drillProject})</span><br /><span className="small">Wipes it, restores this set from the vault, checks every count, then deploys the site there from main. Production is not touched. {set.inVault ? '' : 'This set has no vault copy.'}</span></span></label>
        <label className={`radio ${target === 'temp' ? 'on' : ''}`}><input type="radio" name="target" id="t-temp" checked={target === 'temp'} onChange={() => setTarget('temp')} disabled={set.id !== newestGood} />
          <span><b>Into a temporary database</b><br /><span className="small">Restores inside {p.projectId} into a drill-* database, compares every count, deletes it. {set.id === newestGood ? '' : 'Only for the newest good set.'}</span></span></label>
        <label className={`radio ${target === 'prod' ? 'on' : ''}`}><input type="radio" name="target" id="t-prod" checked={target === 'prod'} onChange={() => setTarget('prod')} />
          <span><b>Into production</b><br /><span className="small">Overwrites documents with the same id and re-imports users. The app never writes to production: run it yourself, as the project owner.</span></span></label>
      </div>
      {target === 'drill' && (
        <>
          {other && <label className="small"><input type="checkbox" id="replace" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> The drill project holds a drill of <b>{holder}</b>. Replace it.</label>}
          <button className="btn primary" disabled={!!busy || !set.inVault || (Boolean(other) && !replace)} onClick={() => run('rebuild', async () => {
            await call('act', { action: 'rebuild', project: p.projectId, runIds: [set.id], replace });
            return { text: 'Rebuild drill started. The log shows each step when it ends; the site deploy follows in GitHub.' };
          })}>{busy ? 'Starting…' : 'Start rebuild drill'}</button>
        </>
      )}
      {target === 'temp' && <button className="btn primary" disabled={!!busy || set.id !== newestGood} onClick={() => run('drill', async () => {
        const r = await call<{ link: string }>('act', { action: 'drill-here', project: p.projectId });
        return { text: 'Restore drill started in GitHub.', link: r.link };
      })}>Start restore drill</button>}
      {target === 'prod' && <Copy text={prodCmd} />}
      {banner}
    </Dialog>
  );
}
