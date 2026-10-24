import { useAllSets, useLog, useProjects, daily } from '../lib/data';
import { bytes, monthlyCost, num, runDate, when, ago, tsDate } from '../lib/format';
import { Bars, Line } from '../components/charts';
import { Pill, statusTone } from '../components/ui';
import { PROJECT_COLORS } from './Overview';

export function Reports() {
  const { rows: projects } = useProjects();
  const sets = useAllSets();
  const { rows: log } = useLog(300);
  if (!projects || !sets) return <p className="muted">Loading…</p>;
  const since = Date.now() - 30 * 86400000;
  return (
    <div className="stack">
      <h1>Reports</h1>
      <div className="tscroll">
        <table>
          <thead><tr><th>Project</th><th>Health</th><th className="n">Good runs, 30 days</th><th className="n">Newest good</th><th className="n">Median run</th><th className="n">Drills, 30 days</th><th className="n">Stored</th><th className="n">Per month</th></tr></thead>
          <tbody>
            {projects.map((p) => {
              const mine = sets.filter((s) => s.projectId === p.projectId && s.inProject);
              const recent = mine.filter((s) => (runDate(s.id)?.getTime() || 0) >= since);
              const good = recent.filter((s) => s.status === 'succeeded');
              const durs = good.map((s) => s.durationSec || 0).filter(Boolean).sort((a, b) => a - b);
              const drills = (log || []).filter((l) => l.project === p.projectId && /drill/.test(l.action) && (tsDate(l.at)?.getTime() || 0) >= since);
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
        const d = daily(sets, projects.map((p) => p.projectId), 30, (s) => s.durationSec ? s.durationSec / 60 : 0);
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
