import { useState } from 'react';
import { useLog, useProjects, type LogLine } from '../lib/data';
import { tsDate, when } from '../lib/format';
import { Pill, statusTone } from '../components/ui';

export function LogList({ rows, compact = false }: { rows: LogLine[]; compact?: boolean }) {
  return (
    <ul className={`log ${compact ? 'compact' : ''}`}>
      {rows.map((r) => (
        <li key={r.id}>
          <span className="t">{when(tsDate(r.at))}</span>
          <span className="what">
            <Pill tone={statusTone(r.status) as any}>{r.status}</Pill>{' '}
            <b>{r.action}</b>
            {r.project ? <> · {r.project}</> : r.repo ? <> · {r.repo}</> : null}
            {r.runIds && r.runIds.length > 0 && <> · <code>{r.runIds.length > 2 ? `${r.runIds.length} sets` : r.runIds.join(', ')}</code></>}
            <span className="muted"> · {r.by}</span>
            {r.link && <> · <a href={r.link} target="_blank" rel="noreferrer">{r.source === 'github' ? 'GitHub run' : 'open'}</a></>}
            {!compact && r.detail && <pre className="detail">{r.detail}</pre>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function LogPage() {
  const [project, setProject] = useState('');
  const [n, setN] = useState(100);
  const [status, setStatus] = useState('');
  const { rows: projects } = useProjects();
  const { rows, error } = useLog(n, project);
  const shown = (rows || []).filter((r) => !status || r.status === status);
  return (
    <div className="stack">
      <h1>Log</h1>
      <p className="muted">Every change made from this app, written before it starts and updated when it ends, plus the GitHub runs (nightly backups, Sunday drills, rebuild deploys). Nobody can edit or delete a line.</p>
      <div className="row wrap">
        <label>Project <select id="log-project" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All</option>
          {(projects || []).map((p) => <option key={p.projectId} value={p.projectId}>{p.label}</option>)}
        </select></label>
        <label>Status <select id="log-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {['succeeded', 'failed', 'refused', 'started', 'running', 'dispatched'].map((s) => <option key={s}>{s}</option>)}
        </select></label>
      </div>
      {error && <p className="banner bad">{error}</p>}
      {rows ? <LogList rows={shown} /> : <p className="muted">Loading…</p>}
      {rows && rows.length >= n && <button className="btn" onClick={() => setN(n + 200)}>Show more</button>}
    </div>
  );
}
