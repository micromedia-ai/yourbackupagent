import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth, call, initFirebase, logOut } from './lib/firebase';
import { link, usePath } from './lib/route';
import { Overview } from './pages/Overview';
import { ProjectPage } from './pages/Project';
import { LogPage } from './pages/Log';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { Protect } from './pages/Protect';
import { Landing } from './pages/Landing';
import { RequestAccess } from './pages/RequestAccess';
import { ConnectAi } from './pages/ConnectAi';
import { Bell } from './components/Bell';

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
  const [checks, setChecks] = useState(0);
  const path = usePath();

  useEffect(() => {
    setAllowed(null);
    if (!user) return;
    call('hello').then(() => setAllowed(true)).catch((e) => {
      setAllowed(false);
      if (e.code !== 'functions/permission-denied') setErr(e.message);
    });
  }, [user, checks]);

  useEffect(() => {
    initFirebase()
      .then(() => onAuthStateChanged(auth(), (u) => { setUser(u); setReady(true); }))
      .catch((e) => { setErr(e.message); setReady(true); });
  }, []);

  if (!ready) return <div className="center muted">Loading…</div>;
  if (err && user) return <div className="center"><p className="banner bad">{err}</p><button className="btn" onClick={() => { setErr(''); logOut(); }}>Sign out</button></div>;
  if (!user) return <Landing onSignIn={() => setErr('')} error={err} />;
  if (allowed === false) return <RequestAccess user={user} onApproved={() => setChecks((c) => c + 1)} />;
  if (allowed !== true) return <div className="center muted">Checking access…</div>;

  const section = path === '/' ? '/' : '/' + path.split('/')[1];
  let page;
  if (path === '/') page = <Overview />;
  else if (path.startsWith('/projects/')) page = <ProjectPage projectId={decodeURIComponent(path.split('/')[2] || '')} user={user} />;
  else if (path === '/log') page = <LogPage />;
  else if (path === '/reports') page = <Reports />;
  else if (path === '/settings') page = <Settings />;
  else if (path === '/protect') page = <Protect />;
  else if (path === '/connect-ai') page = <ConnectAi email={user.email || ''} />;
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
        <span className="who"><Bell /> {user.email} <button className="btn ghost small" onClick={() => logOut()}>Sign out</button></span>
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
