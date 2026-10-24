import { useEffect, useMemo, useState } from 'react';
import { call } from '../lib/firebase';

// /connect-ai: the sign-in step of the MCP connector (functions/lib/oauth.js).
// An assistant such as Claude opens it with its client id, return address and
// PKCE challenge; someone on the access list (the app's own sign-in) taps
// Allow and goes back with a one-time code, or Cancel.
export function ConnectAi({ email }: { email: string }) {
  const params = useMemo(() => {
    const q = new URLSearchParams(location.search);
    return {
      client_id: q.get('client_id') || '', redirect_uri: q.get('redirect_uri') || '', state: q.get('state') || '',
      code_challenge: q.get('code_challenge') || '', code_challenge_method: q.get('code_challenge_method') || '', resource: q.get('resource') || '',
      ok: q.get('response_type') === 'code',
    };
  }, []);
  const [client, setClient] = useState<{ clientName: string; redirectHost: string } | null>(null);
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);
  const wellFormed = params.ok && Boolean(params.client_id && params.redirect_uri);

  useEffect(() => {
    if (!wellFormed) return;
    call<{ clientName: string; redirectHost: string }>('mcpConsent', { action: 'describe', ...params })
      .then(setClient).catch((e) => setFailed(e.message));
  }, [params, wellFormed]);

  async function answer(allow: boolean) {
    setBusy(true);
    try {
      const r = await call<{ redirect: string }>('mcpConsent', { action: allow ? 'approve' : 'deny', ...params });
      window.location.assign(r.redirect);
    } catch (e: any) {
      setFailed(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="stack narrow">
      <h1>Connect an AI assistant</h1>
      <section className="panel">
        {!wellFormed || failed ? (
          <p className="banner bad" role="alert">This sign-in link is not valid{failed ? `: ${failed}` : ''}. Start again from the assistant's connector settings.</p>
        ) : !client ? (
          <p className="muted">Checking…</p>
        ) : (
          <>
            <p><b>{client.clientName}</b> asks to use YourBackupAgent as you ({email}).</p>
            <p className="small">It will be able to:</p>
            <ul className="small">
              <li>see every project, its backup sets, health and the log</li>
              <li>start a backup, a restore drill or a rebuild drill</li>
              <li>prune and delete sets in a project's bucket, never below its minimum of good sets</li>
            </ul>
            <p className="small">It cannot delete vault copies or write to production. Everything it does is in the log with your name. Disconnect it any time in Settings.</p>
            <p className="small muted">Allow sends you back to {client.redirectHost}.</p>
            <div className="row wrap">
              <button className="btn primary" disabled={busy} onClick={() => void answer(true)}>{busy ? 'Working…' : 'Allow'}</button>
              <button className="btn" disabled={busy} onClick={() => void answer(false)}>Cancel</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
