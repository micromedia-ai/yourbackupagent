import { call } from '../lib/firebase';
import { daily, useAllSets, useDoc, useLog, useProjects, type Project } from '../lib/data';
import { ago, bytes, runDate, tsDate, when } from '../lib/format';
import { link } from '../lib/route';
import { Bars } from '../components/charts';
import { Pill, statusTone, useBusy } from '../components/ui';
import { LogList } from './Log';

export const PROJECT_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];

export function DrillSlot() {
  const slot = useDoc<{ project: string; labels: Record<string, string>; refreshedAt: any }>('drill/slot');
  if (!slot) return null;
  const l = slot.labels || {};
  const of = l['drill-of'];
  const state = l['drill-data'];
  return (
    <div className="slot">
      <span className="label">Drill project</span> <code>{slot.project}</code>{' '}
      {!of ? <Pill tone="ok">free</Pill> : state === 'running' ? <Pill tone="warn">busy: drill of {of} running</Pill>
        : <Pill tone={state === 'passed' ? 'info' : 'bad'}>holds a drill of {of} ({state || 'unknown'}{l['drill-site'] ? `, site ${l['drill-site']}` : ''})</Pill>}
      <span className="muted small"> · checked {ago(tsDate(slot.refreshedAt))}</span>
    </div>
  );
}

export function RefreshButton() {
  const { busy, run, banner } = useBusy();
  return (
    <>
      <button className="btn" disabled={!!busy} onClick={() => run('refresh', async () => {
        const r = await call<{ results: any[] }>('refresh');
        const bad = r.results.filter((x) => x.error || (x.errors && x.errors.length));
        return { text: bad.length ? `Refreshed, with problems: ${bad.map((b) => `${b.projectId || b.repo}: ${b.error || b.errors.join('; ')}`).join(' · ')}` : 'Refreshed every project.' };
      })}>{busy ? 'Refreshing…' : 'Refresh now'}</button>
      {banner}
    </>
  );
}

function Card({ p }: { p: Project }) {
  const h = p.health || { level: 'bad', text: 'Not read yet' };
  return (
    <a className="pcard" {...link(`/projects/${encodeURIComponent(p.projectId)}`)}>
      <span className="pname">{p.label}</span>
      <code className="small muted">{p.projectId}</code>
      <span><Pill tone={statusTone(h.level)}>{h.text}</Pill></span>
      <span className="small muted">
        {h.newestGood ? `Good backup ${ago(runDate(h.newestGood))}` : 'No good backup'} · {h.goodCount ?? 0} good sets (keeps ≥ {p.keepMinSets})
        {p.totals ? ` · ${bytes(p.totals.bytes)}` : ''}
      </span>
      {p.errors && p.errors.length > 0 && <span className="small bad-text">{p.errors[0]}</span>}
    </a>
  );
}

export function Overview() {
  const { rows: projects, error } = useProjects();
  const sets = useAllSets();
  const { rows: log } = useLog(8);
  const ids = (projects || []).map((p) => p.projectId);
  const d = sets && projects ? daily(sets, ids) : null;
  return (
    <div className="stack">
      <div className="row between">
        <h1>Overview</h1>
        <div className="row"><RefreshButton /></div>
      </div>
      {error && <p className="banner bad">{error}</p>}
      <DrillSlot />
      <div className="cards">
        {(projects || []).map((p) => <Card key={p.projectId} p={p} />)}
        <a className="pcard add" {...link('/protect')}>+ Protect a repository</a>
      </div>
      {projects && projects.length === 0 && <p className="muted">No projects read yet. Press Refresh now (it reads every repository listed in Settings).</p>}
      <div className="split">
        <section className="panel">
          <h4>Good backups per day, last 30 days</h4>
          {d ? <Bars labels={d.labels} flags={d.failed} unit={bytes} series={(projects || []).map((p, i) => ({ label: p.label, color: PROJECT_COLORS[i % 4], values: d.values[i] }))} /> : <p className="muted">Loading…</p>}
          <div className="legend">
            {(projects || []).map((p, i) => <span key={p.projectId}><i style={{ background: PROJECT_COLORS[i % 4] }} />{p.label}</span>)}
            <span><i style={{ background: 'var(--bad)', height: 4 }} />red mark: a run failed that day</span>
          </div>
        </section>
        <section className="panel">
          <div className="row between"><h4>Latest actions</h4><a className="small" {...link('/log')}>Whole log</a></div>
          {log ? <LogList rows={log} compact /> : <p className="muted">Loading…</p>}
          {log && log.length === 0 && <p className="muted">Nothing yet.</p>}
          <p className="small muted">Times are your local time. Latest refresh {when(tsDate(projects?.[0]?.refreshedAt))}.</p>
        </section>
      </div>
    </div>
  );
}
