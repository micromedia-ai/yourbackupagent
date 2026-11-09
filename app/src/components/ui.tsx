import { useEffect, useState, type ReactNode } from 'react';

export function Pill({ tone = 'info', children, title }: { tone?: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; children: ReactNode; title?: string }) {
  return <span className={`pill ${tone}`} title={title}>{children}</span>;
}

export const statusTone = (s: string) =>
  s === 'paused' ? 'muted' : s === 'succeeded' || s === 'ok' ? 'ok' : s === 'failed' || s === 'refused' || s === 'bad' ? 'bad' : s === 'incomplete' || s === 'warn' || s === 'unknown' ? 'warn' : 'info';

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head"><h3>{title}</h3><button className="btn ghost" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="code">
      <pre>{text}</pre>
      <button className="btn small" onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {})}>
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function useBusy() {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string; link?: string } | null>(null);
  async function run(label: string, f: () => Promise<{ text: string; link?: string } | void>) {
    setBusy(label); setMsg(null);
    try {
      const r = await f();
      if (r) setMsg({ tone: 'ok', ...r });
    } catch (e: any) {
      setMsg({ tone: 'bad', text: e?.message || String(e) });
    } finally {
      setBusy('');
    }
  }
  const banner = msg && (
    <div className={`banner ${msg.tone}`} role="status">
      {msg.text} {msg.link && <a href={msg.link} target="_blank" rel="noreferrer">Open</a>}
      <button className="btn ghost small" onClick={() => setMsg(null)} aria-label="Dismiss">✕</button>
    </div>
  );
  return { busy, run, banner };
}
