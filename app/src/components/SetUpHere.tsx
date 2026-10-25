import { useState } from 'react';
import { call, cloudSignIn } from '../lib/firebase';
import { useDoc } from '../lib/data';
import { Pill } from './ui';

type SignIn = { email: string; token: string };
type Log = { status: string; detail?: string };

// The one-time setup of a protected repository, from the browser: you sign in
// as the project's owner (and the vault owner, when another account), and the
// app's runner does what onboard.sh does on a Mac. Nothing is kept: the
// sign-in is used once and expires within the hour.
export function SetUpHere({ repo, projectId }: { repo: string; projectId: string }) {
  const [owner, setOwner] = useState<SignIn | null>(null);
  const [vault, setVault] = useState<SignIn | null>(null);
  const [needVault, setNeedVault] = useState('');
  const [logId, setLogId] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const signIn = async (which: 'owner' | 'vault') => {
    setErr(''); setBusy(which);
    try {
      const s = await cloudSignIn(which === 'vault' ? needVault : '');
      if (which === 'owner') setOwner(s); else setVault(s);
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(''); }
  };
  const start = async () => {
    setErr(''); setBusy('start');
    try {
      const r = await call<{ log: string }>('onboard', { repo, ownerToken: owner!.token, ...(vault ? { vaultToken: vault.token } : {}) });
      setLogId(r.log);
    } catch (e: any) {
      if (e?.details?.needVault) { setNeedVault(e.details.needVault); setVault(null); }
      setErr(e?.message || String(e));
    } finally { setBusy(''); }
  };

  return (
    <div className="stack" id="set-up-here">
      <h4>Set it up here</h4>
      <p className="small">No terminal: sign in with Google as an owner of <code>{projectId}</code>. The app then makes the backup account (GitHub signs in to Google with it without any stored key), the backup bucket, protection and the vault copy, lets itself read the backups, and takes the first backup. Your sign-in is used once and is never stored.</p>
      {!logId && (
        <ol className="steps">
          <li><span>Sign in as an owner of {projectId}{owner && <> <Pill tone="ok">{owner.email}</Pill></>}</span>
            <button className="btn" id="owner-sign-in" disabled={!!busy} onClick={() => signIn('owner')}>{owner ? 'Another account' : busy === 'owner' ? 'Signing in…' : 'Sign in with Google'}</button></li>
          {needVault && (
            <li><span>Also sign in as the vault owner, {needVault}{vault && <> <Pill tone="ok">{vault.email}</Pill></>}</span>
              <button className="btn" id="vault-sign-in" disabled={!!busy} onClick={() => signIn('vault')}>{vault ? 'Another account' : busy === 'vault' ? 'Signing in…' : 'Sign in with Google'}</button></li>
          )}
          <li><span>Set up {projectId} and take the first backup</span>
            <button className="btn primary" id="start-setup" disabled={!!busy || !owner || (!!needVault && !vault)} onClick={start}>{busy === 'start' ? 'Starting…' : 'Set it up'}</button></li>
        </ol>
      )}
      {err && <div className="banner bad" role="status">{err}</div>}
      {logId && <SetUpProgress id={logId} />}
    </div>
  );
}

function SetUpProgress({ id }: { id: string }) {
  const log = useDoc<Log>(`log/${id}`);
  const status = log?.status || 'started';
  const done = status === 'succeeded';
  const failed = status === 'failed';
  return (
    <div className="stack" id="setup-progress">
      <p>{done ? <Pill tone="ok">set up</Pill> : failed ? <Pill tone="bad">failed</Pill> : <Pill tone="info">setting up…</Pill>}{' '}
        {done ? 'Done. Merge the pull request so the nightly backup runs; then try a rebuild drill from the project page.'
          : failed ? 'Something failed; the steps below say where. Fix it and set it up again (every step can run again).'
          : 'About 5 to 15 minutes. You can leave this page; the log has the result.'}</p>
      {log?.detail && <pre className="small log-detail">{log.detail}</pre>}
    </div>
  );
}
