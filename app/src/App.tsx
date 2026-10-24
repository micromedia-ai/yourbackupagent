import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth, call, initFirebase, logOut, signIn } from './lib/firebase';
import { link, usePath } from './lib/route';
import { Overview } from './pages/Overview';
import { ProjectPage } from './pages/Project';
import { LogPage } from './pages/Log';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Protect } from './pages/Protect';

const NAV = [
  ['/', 'Overview'],
  ['/log', 'Log'],
  ['/reports', 'Reports'],
  ['/settings', 'Settings'],
] as const;

export function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [err, setErr] = useState('');
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const path = usePath();

  useEffect(() => {
    if (!user) { setAllowed(null); return; }
    call('hello').then(() => setAllowed(true)).catch((e) => { setAllowed(false); setErr(e.message); });
  }, [user]);

  useEffect(() => {
    initFirebase()
      .then(() => onAuthStateChanged(auth(), (u) => { setUser(u); setReady(true); }))
      .catch((e) => { setErr(e.message); setReady(true); });
  }, []);

  if (!ready) return <div className="center muted">Loading…</div>;
  if (err) return <div className="center"><p className="banner bad">{err}</p>{user && <button className="btn" onClick={() => { setErr(''); logOut(); }}>Sign out</button>}</div>;
  if (!user) {
    return (
      <div className="center signin">
        <img src="/icon.svg" width={48} height={48} alt="" />
        <h1>YourBackupAgent</h1>
        <p className="muted">Backups of every project, in one place. Sign in with the Google account on the access list.</p>
        <button className="btn primary" onClick={() => signIn().catch((e) => setErr(e.message))}>Sign in with Google</button>
      </div>
    );
  }

  if (allowed !== true) return <div className="center muted">Checking access…</div>;

  const section = path === '/' ? '/' : '/' + path.split('/')[1];
  let page;
  if (path === '/') page = <Overview />;
  else if (path.startsWith('/projects/')) page = <ProjectPage projectId={decodeURIComponent(path.split('/')[2] || '')} user={user} />;
  else if (path === '/log') page = <LogPage />;
  else if (path === '/reports') page = <Reports />;
  else if (path === '/settings') page = <Settings />;
  else if (path === '/protect') page = <Protect />;
  else page = <p>Not found. <a {...link('/')}>Overview</a></p>;

  return (
    <div className="shell">
      <header className="top">
        <a className="logo" {...link('/')}><img src="/icon.svg" width={20} height={20} alt="" /> YourBackupAgent</a>
        <nav className="nav">
          {NAV.map(([p, label]) => (
            <a key={p} {...link(p)} className={section === p || (p === '/' && section === '/projects') ? 'on' : ''}>{label}</a>
          ))}
        </nav>
        <span className="who">{user.email} <button className="btn ghost small" onClick={() => logOut()}>Sign out</button></span>
      </header>
      <main className="main">{page}</main>
      <nav className="bottom-nav">
        {NAV.map(([p, label]) => (
          <a key={p} {...link(p)} className={section === p || (p === '/' && section === '/projects') ? 'on' : ''}>{label}</a>
        ))}
      </nav>
    </div>
  );
}
