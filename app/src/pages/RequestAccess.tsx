// Signed in, but not on the access list: ask the owners for an invite.
import { useState } from 'react';
import type { User } from 'firebase/auth';
import { call, logOut } from '../lib/firebase';
import { useDoc } from '../lib/data';

export function RequestAccess({ user, onApproved }: { user: User; onApproved: () => void }) {
  const email = (user.email || '').toLowerCase();
  const req = useDoc<{ status: string }>(`requests/${email}`);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const status = req === undefined ? 'loading' : req ? req.status : 'none';

  async function ask() {
    setBusy(true); setErr('');
    try {
      const r = await call<{ status: string }>('requestAccess', { note });
      if (r.status === 'approved') onApproved();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="center">
      <div className="panel askbox">
        <span className="logo"><img src="/icon.svg" width={22} height={22} alt="" /> YourBackupAgent</span>
        <h1>Invite only</h1>
        <p>You are signed in as <b>{email}</b>, which is not on the access list yet.</p>
        {status === 'pending' && <p className="banner ok" role="status">Asked. The owner got an email; you get one when you are let in.</p>}
        {status === 'declined' && <p className="banner bad">Your request was declined.</p>}
        {status === 'approved' && <button className="btn primary" onClick={onApproved}>You are in: open the app</button>}
        {(status === 'none' || status === 'loading') && (
          <>
            <label>A note for the owner (optional)<textarea id="ask-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who you are and which projects you look after" /></label>
            <button className="btn primary" disabled={busy} onClick={ask}>{busy ? 'Asking…' : 'Ask for access'}</button>
          </>
        )}
        {err && <p className="banner bad">{err}</p>}
        <button className="btn ghost" onClick={() => logOut()}>Use another account</button>
      </div>
    </div>
  );
}
