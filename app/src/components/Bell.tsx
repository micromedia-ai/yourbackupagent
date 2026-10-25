import { useEffect, useRef, useState } from 'react';
import { useProjects } from '../lib/data';
import { link } from '../lib/route';
import { Pill, statusTone } from './ui';

// Alerts (projects that need attention) behind a bell in the top bar. A
// hidden alert stays hidden in this browser until its text changes, so a new
// or different problem shows again.
const KEY = 'yba.hiddenAlerts';
const readHidden = (): string[] => {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
};
const writeHidden = (v: string[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window: hiding lasts until reload */ }
};

export function Bell() {
  const { rows: projects } = useProjects();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  const alerts = (projects || []).filter((p) => p.health && p.health.level !== 'ok')
    .map((p) => ({ p, key: `${p.projectId}|${p.health.text}` }));
  const shown = alerts.filter((a) => !hidden.includes(a.key));
  const nHidden = alerts.length - shown.length;
  const worst = shown.some((a) => a.p.health.level === 'bad') ? 'bad' : 'warn';
  const hide = (k: string[]) => {
    // Forget hidden alerts that no longer exist, so the list does not grow.
    const next = [...new Set([...hidden, ...k])].filter((h) => alerts.some((a) => a.key === h));
    setHidden(next); writeHidden(next);
  };

  return (
    <div className="bell" ref={box}>
      <button className="btn ghost bell-btn" id="bell" aria-label={`Alerts: ${shown.length}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {shown.length > 0 && <span className={`bell-n ${worst}`}>{shown.length}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Alerts">
          <div className="row between"><h4>Needs attention</h4>
            {shown.length > 1 && <button className="linkish small" onClick={() => hide(shown.map((a) => a.key))}>Hide all</button>}
          </div>
          {shown.length === 0 && <p className="small muted">Nothing needs attention{nHidden ? '' : ': every project is healthy'}.</p>}
          {shown.map(({ p, key }) => (
            <div key={key} className="bell-item">
              <a {...link(`/projects/${encodeURIComponent(p.projectId)}`)} onClick={() => setOpen(false)}>
                <Pill tone={statusTone(p.health.level)}>{p.label}</Pill>
                <span className="small">{p.health.text}</span>
              </a>
              <button className="btn ghost small" aria-label={`Hide the alert for ${p.label}`} onClick={() => hide([key])}>Hide</button>
            </div>
          ))}
          {nHidden > 0 && (
            <button className="linkish small" onClick={() => { setHidden([]); writeHidden([]); }}>Show {nHidden} hidden</button>
          )}
        </div>
      )}
    </div>
  );
}
