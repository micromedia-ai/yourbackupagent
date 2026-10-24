// The front page for people who are not signed in. Invite only: signing in
// with a Google account that is not on the list leads to "ask for access".
import { signIn } from '../lib/firebase';
import { StatusGrid } from '../components/charts';

const DAYS = 21;
// A made-up month for the picture: two projects, one bad night, one drill.
const demo = (fail: number[]) => Array.from({ length: DAYS }, (_, i) => (fail.includes(i) ? 'failed' : 'succeeded'));

const FEATURES = [
  ['Every night, every project', 'Firestore at one consistent moment, Storage files, Auth users with password hashes and the project config, into a bucket in the project.'],
  ['A copy somewhere else', 'Each set is copied to a separate vault project, so a deleted project or a leaked deploy key does not take the backups with it.'],
  ['Proven by restoring', 'Weekly restore drills compare every count, and a rebuild drill brings the whole site up in a spare project from one click.'],
  ['Never fewer than you set', 'Old sets are cleaned up by age, but the newest good ones (7 by default) are never deleted, by the schedule or by anyone in the app.'],
  ['Everything written down', 'Every backup, delete, restore and setting change is in one log that nobody can edit, with who did it and what came out.'],
  ['Told when it matters', 'An email when a project falls behind or a drill fails, another when it recovers, and a short summary every Monday.'],
] as const;

const NEVER = [
  'It never writes to a production project. A production restore is a command it shows you to run yourself.',
  'Its own account can read the vault but not delete there. Deleting vault copies takes your own Google sign-in.',
  'Backups hold your data; the app, its log and its emails only ever show ids, counts, sizes and statuses.',
];

export function Landing({ onSignIn, error }: { onSignIn: () => void; error?: string }) {
  const start = () => signIn().then(onSignIn).catch(() => {});
  return (
    <div className="landing">
      <header className="lnav">
        <span className="logo"><img src="/icon.svg" width={22} height={22} alt="" /> YourBackupAgent</span>
        <button className="btn" onClick={start}>Sign in</button>
      </header>

      <section className="hero">
        <div className="hero-text">
          <span className="eyebrow">Invite only</span>
          <h1>Backups for every Firebase project, checked every night and proven by restoring them.</h1>
          <p className="lead">YourBackupAgent backs up your Firebase and Google Cloud projects, keeps a copy in a separate vault, drills the restore, and tells you the moment something slips. One place to see all of it.</p>
          <div className="row wrap">
            <button className="btn primary big" onClick={start}>Sign in with Google</button>
            <button className="btn big" onClick={start}>Ask for an invite</button>
          </div>
          <p className="small muted">Not on the list yet? Sign in with Google and ask: the owner gets an email and lets you in.</p>
          {error && <p className="banner bad">{error}</p>}
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="mock">
            <div className="mock-row"><b>Foundation Next</b><span className="pill ok">Healthy</span></div>
            <div className="mock-sub">Good backup 3h ago · 12 good sets (keeps ≥ 7) · 4.1 GB</div>
            <div className="mock-row"><b>Content Creator</b><span className="pill warn">The newest run failed</span></div>
            <div className="mock-sub">Good backup 27h ago · 9 good sets (keeps ≥ 7) · 1.3 GB</div>
            <StatusGrid days={DAYS} rows={[{ label: 'Foundation Next', cells: demo([]) }, { label: 'Content Creator', cells: demo([DAYS - 1, 6]) }]} />
            <div className="mock-foot"><span className="pill info">drill passed</span> Rebuild drill of Foundation Next, 31 min</div>
          </div>
        </div>
      </section>

      <section className="features">
        {FEATURES.map(([t, d]) => (
          <div className="feature" key={t}><h3>{t}</h3><p>{d}</p></div>
        ))}
      </section>

      <section className="how">
        <h2>Three steps per project</h2>
        <ol>
          <li><b>Protect a repository.</b> The app opens a pull request with the backup kit, filled in from the repository's Firebase settings.</li>
          <li><b>Run one command.</b> <code>./onboard.sh owner/repo</code> sets up the buckets, protection and access, takes the first backup and offers a drill.</li>
          <li><b>Merge.</b> From then on it backs up every night, drills every Sunday, and the app shows how it went.</li>
        </ol>
      </section>

      <section className="never">
        <h2>What it will never do</h2>
        <ul>{NEVER.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>

      <footer className="lfoot">
        <span>YourBackupAgent · invite only</span>
        <button className="linkish" onClick={start}>Sign in</button>
      </footer>
    </div>
  );
}
