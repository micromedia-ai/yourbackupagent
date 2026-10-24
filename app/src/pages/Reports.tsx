import { useState } from 'react';
import { useAllSets, useLog, useProjects, daily, dayKeys, statusCells } from '../lib/data';
import { bytes, monthlyCost, num, runDate, when, ago, tsDate } from '../lib/format';
import { Bars, HBars, Line, StatusGrid } from '../components/charts';
import { Pill, statusTone } from '../components/ui';
import { Kpis, PROJECT_COLORS } from './Overview';
import { LogList } from './Log';

export function Reports() {
  const { rows: projects } = useProjects();
  const sets = useAllSets();
  const { rows: log } = useLog(300);
  const [days, setDays] = useState(30);
  if (!projects || !sets) return <p className="muted">Loading…</p>;
  const since = Date.now() - days * 86400000;
  const k = dayKeys(days);
  const counts = (status: string) => k.keys.map((key) => sets.filter((s) => s.inProject && s.id.startsWith(key) && (status === 'good' ? s.status === 'succeeded' : s.status !== 'succeeded')).length);
  const drills = (log || []).filter((l) => /^(rebuild|restore) drill/.test(l.action) && (tsDate(l.at)?.getTime() || 0) >= since);
  const ageH = (p: (typeof projects)[number]) => (p.health?.newestGood ? (Date.now() - (runDate(p.health.newestGood)?.getTime() || 0)) / 3600000 : 0);
  const maxAge = Math.max(...projects.map((p) => p.maxAgeHours || 26), 26);
  function csv() {
    const head = ['project', 'set', 'status', 'started', 'minutes', 'documents', 'files', 'users', 'bytes', 'in_project', 'in_vault'];
    const lines = sets!.map((s) => [s.projectId, s.id, s.status, s.startedAt || '', s.durationSec ? Math.round(s.durationSec / 60) : '', s.docs ?? '', s.files ?? '', s.users ?? '', s.bytes, s.inProject, s.inVault].join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' }));
    a.download = `backup-sets-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }
  return (
    <div className="stack">
      <div className="row between wrap">
        <h1>Reports</h1>
        <div className="row">
          <div className="seg" role="group" aria-label="Period">
            {[7, 30, 90].map((n) => <button key={n} className={n === days ? 'on' : ''} onClick={() => setDays(n)}>{n} days</button>)}
          </div>
          <button className="btn" onClick={csv}>Download CSV</button>
        </div>
      </div>
      <Kpis days={days} />
      <section className="panel">
        <h4>Every night, last {days} days</h4>
        <StatusGrid days={days} dayLabels={k.labels} rows={projects.map((p) => ({ label: p.label, cells: statusCells(sets, p.projectId, k.keys) }))} />
      </section>
      <div className="split">
        <section className="panel">
          <h4>Runs per day</h4>
          <Bars labels={k.labels} unit={(v) => String(Math.round(v))} series={[{ label: 'good', color: 'var(--ok)', values: counts('good') }, { label: 'failed or incomplete', color: 'var(--bad)', values: counts('bad') }]} />
          <div className="legend"><span><i style={{ background: 'var(--ok)' }} />good</span><span><i style={{ background: 'var(--bad)' }} />failed or incomplete</span></div>
        </section>
        <section className="panel">
          <h4>Hours since the newest good backup</h4>
          <HBars rows={projects.map((p) => { const h = ageH(p); return { label: p.label, value: h, tone: h > (p.maxAgeHours || 26) ? 'var(--bad)' : 'var(--ok)' }; })} unit={(v) => `${Math.round(v)}h`} limit={maxAge} limitLabel={`the ${maxAge}h limit a check fails at`} />
        </section>
        <section className="panel">
          <h4>Stored per project (project bucket + vault)</h4>
          <HBars rows={projects.map((p, i) => ({ label: p.label, value: p.totals?.bytes || 0, tone: PROJECT_COLORS[i % 4] }))} unit={bytes} />
        </section>
        <section className="panel">
          <h4>Drills, last {days} days</h4>
          {drills.length ? <LogList rows={drills.slice(0, 8)} compact /> : <p className="muted">No drills in this period.</p>}
        </section>
      </div>
      <div className="tscroll">
        <table>
          <thead><tr><th>Project</th><th>Health</th><th className="n">Good runs, {days} days</th><th className="n">Newest good</th><th className="n">Median run</th><th className="n">Drills, {days} days</th><th className="n">Stored</th><th className="n">Per month</th></tr></thead>
          <tbody>
            {projects.map((p) => {
              const mine = sets.filter((s) => s.projectId === p.projectId && s.inProject);
              const recent = mine.filter((s) => (runDate(s.id)?.getTime() || 0) >= since);
              const good = recent.filter((s) => s.status === 'succeeded');
              const durs = good.map((s) => s.durationSec || 0).filter(Boolean).sort((a, b) => a - b);
              const drills = (log || []).filter((l) => l.project === p.projectId && /^(rebuild|restore) drill/.test(l.action) && (tsDate(l.at)?.getTime() || 0) >= since);
              return (
                <tr key={p.projectId}>
                  <td>{p.label}</td>
                  <td><Pill tone={statusTone(p.health?.level || 'bad') as any}>{p.health?.text}</Pill></td>
                  <td className="n">{good.length} of {recent.length}</td>
                  <td className="n">{p.health?.newestGood ? ago(runDate(p.health.newestGood)) : '—'}</td>
                  <td className="n">{durs.length ? `${Math.round(durs[Math.floor(durs.length / 2)] / 60)} min` : '—'}</td>
                  <td className="n">{drills.filter((d) => d.status === 'succeeded').length} passed, {drills.filter((d) => d.status === 'failed').length} failed</td>
                  <td className="n">{bytes(p.totals?.bytes || 0)}</td>
                  <td className="n">${monthlyCost(p.totals?.bytes || 0).toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(() => {
        const d = daily(sets, projects.map((p) => p.projectId), days, (s) => s.durationSec ? s.durationSec / 60 : 0);
        return (
          <section className="panel"><h4>Run length per day (minutes)</h4>
            <Bars width={1100} height={170} labels={d.labels} flags={d.failed} unit={(v) => `${Math.round(v)}m`} series={projects.map((p, i) => ({ label: p.label, color: PROJECT_COLORS[i % 4], values: d.values[i] }))} />
          </section>
        );
      })()}
      {projects.map((p) => {
        const good = sets.filter((s) => s.projectId === p.projectId && s.status === 'succeeded' && s.inProject).sort((a, b) => (a.id < b.id ? -1 : 1));
        return (
          <section className="panel" key={p.projectId}>
            <h4>{p.label}</h4>
            <div className="split">
              <div><span className="small muted">Documents</span><Line labels={good.map((s) => when(runDate(s.id)))} values={good.map((s) => s.docs || 0)} unit={(v) => num(Math.round(v))} width={380} height={130} /></div>
              <div><span className="small muted">Size of one set</span><Line labels={good.map((s) => when(runDate(s.id)))} values={good.map((s) => s.project?.bytes || s.bytes)} unit={bytes} width={380} height={130} /></div>
              <div><span className="small muted">Users</span><Line labels={good.map((s) => when(runDate(s.id)))} values={good.map((s) => s.users || 0)} unit={(v) => num(Math.round(v))} width={380} height={130} /></div>
              <div><span className="small muted">Files</span><Line labels={good.map((s) => when(runDate(s.id)))} values={good.map((s) => s.files || 0)} unit={(v) => num(Math.round(v))} width={380} height={130} /></div>
            </div>
          </section>
        );
      })}
      <p className="small muted">Storage cost uses $0.026 per GB-month (US multi-region standard). Google-managed Firestore backups and point-in-time recovery are billed separately by Google.</p>
    </div>
  );
}
