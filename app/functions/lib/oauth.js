// OAuth sign-in for the MCP connector (OAuth 2.1 with PKCE and dynamic
// client registration, as MCP clients such as Claude expect). Ported from
// limorgilat.com's admin connector.
//
// Adding https://<app>/mcp as a custom connector: the client gets a 401 that
// points at /.well-known/oauth-protected-resource, reads
// /.well-known/oauth-authorization-server, registers itself, then opens
// /connect-ai in the app. Someone on the access list signs in there with
// Google and taps Allow; the client trades the one-time code for an access
// token (1 hour) and a refresh token (30 days, replaced on every use). Each
// Allow is a "grant" listed in Settings, where it can be disconnected. A
// token stops working at once when its grant is removed or its person leaves
// the access list.
//
// Only clients that send the person back to an allowed address can register
// (Claude's own sites and local apps), so a link someone else made can't send
// a code to their server. Codes and tokens are stored only as hashes. Pure
// logic; Firebase-free, the store is injected.
import { createHash, timingSafeEqual } from 'node:crypto';

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const SCOPE = 'backups';

/** Where a client may send the admin back to after Allow. */
export const REDIRECT_HOSTS = ['claude.ai', 'claude.com'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Subcollections of the server-only mcp/oauth document (firestore.rules).
export const COLLECTIONS = {
  clients: 'mcp/oauth/clients',
  codes: 'mcp/oauth/codes',
  tokens: 'mcp/oauth/tokens',
  grants: 'mcp/oauth/grants',
};

export const hashSecret = (s) => createHash('sha256').update(String(s)).digest('hex');

export class OAuthError extends Error {
  constructor(error, description = '', status = 400) {
    super(description || error);
    this.error = error;
    this.description = description;
    this.status = status;
  }
}

/** True when `uri` is an https address on an allowed host, or a local app. */
export function redirectAllowed(uri) {
  let u;
  try { u = new URL(String(uri)); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  if (LOCAL_HOSTS.includes(u.hostname)) return u.protocol === 'http:' || u.protocol === 'https:';
  return u.protocol === 'https:' && REDIRECT_HOSTS.includes(u.hostname);
}

export function resourceUrl(base) {
  return `${base}/mcp`;
}

/** RFC 9728: what protects the MCP endpoint. */
export function resourceMetadata(base) {
  return {
    resource: resourceUrl(base),
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'YourBackupAgent',
  };
}

/** RFC 8414: the authorization server's endpoints. */
export function authServerMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/connect-ai`,
    token_endpoint: `${base}/mcp/oauth/token`,
    registration_endpoint: `${base}/mcp/oauth/register`,
    revocation_endpoint: `${base}/mcp/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE],
  };
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function pkceMatches(verifier, challenge) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(String(verifier || ''))) return false;
  const computed = createHash('sha256').update(String(verifier)).digest('base64url');
  return sameSecret(computed, challenge);
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * deps: { store, now(): ms, random(): url-safe random string, isAllowed(email): Promise<bool> }.
 * store: get(col, id), set(col, id, data), update(col, id, data),
 * take(col, id) (read and delete at once), delete(col, id),
 * query(col, field, value) → [{ id, data }], purgeExpired?(col, ms).
 */
export function createOAuth(deps) {
  const { store } = deps;
  const now = () => deps.now();
  const C = COLLECTIONS;

  async function client(clientId) {
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(String(clientId || ''))) throw new OAuthError('invalid_client', 'unknown client', 401);
    const c = await store.get(C.clients, clientId);
    if (!c) throw new OAuthError('invalid_client', 'unknown client', 401);
    return c;
  }

  async function clientFor(clientId, redirectUri) {
    const c = await client(clientId);
    if (!c.redirectUris.includes(String(redirectUri || ''))) throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
    return c;
  }

  function redirectWith(uri, params) {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return u.toString();
  }

  async function issue(grantId) {
    const access = `ybat_${deps.random()}`;
    const refresh = `ybrt_${deps.random()}`;
    const t = now();
    await store.set(C.tokens, hashSecret(access), { type: 'access', grantId, expiresAt: t + ACCESS_TTL_MS });
    await store.set(C.tokens, hashSecret(refresh), { type: 'refresh', grantId, expiresAt: t + REFRESH_TTL_MS });
    if (store.purgeExpired) {
      await Promise.all([store.purgeExpired(C.tokens, t), store.purgeExpired(C.codes, t)]).catch(() => {});
    }
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: SCOPE };
  }

  return {
    /** RFC 7591 dynamic client registration. */
    async register(body) {
      const b = body && typeof body === 'object' ? body : {};
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map((u) => String(u)) : [];
      if (!uris.length || uris.length > 5 || uris.some((u) => u.length > 500)) {
        throw new OAuthError('invalid_redirect_uri', 'one to five redirect_uris are required');
      }
      const bad = uris.find((u) => !redirectAllowed(u));
      if (bad) throw new OAuthError('invalid_redirect_uri', `redirect_uri not allowed: ${bad.slice(0, 120)}`);
      const method = b.token_endpoint_auth_method || 'none';
      if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
        throw new OAuthError('invalid_client_metadata', 'unsupported token_endpoint_auth_method');
      }
      const clientId = `ybc_${deps.random()}`.slice(0, 60);
      const secret = method === 'none' ? null : `ybcs_${deps.random()}`;
      const record = {
        name: clean(b.client_name, 100) || 'AI assistant',
        redirectUris: uris,
        authMethod: method,
        secretHash: secret ? hashSecret(secret) : null,
        createdAt: now(),
      };
      await store.set(C.clients, clientId, record);
      return {
        client_id: clientId,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(record.createdAt / 1000),
        client_name: record.name,
        redirect_uris: uris,
        token_endpoint_auth_method: method,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: SCOPE,
      };
    },

    /** For the consent page: who is asking, and where Allow sends you. */
    async describe({ clientId, redirectUri }) {
      const c = await clientFor(clientId, redirectUri);
      return { clientName: c.name, redirectHost: new URL(redirectUri).host };
    },

    /** The admin tapped Allow: a one-time code for the client. */
    async approve({ clientId, redirectUri, codeChallenge, codeChallengeMethod, state, resource, user }) {
      await clientFor(clientId, redirectUri);
      if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(codeChallenge || ''))) {
        throw new OAuthError('invalid_request', 'PKCE with S256 is required');
      }
      if (!user?.email) throw new OAuthError('access_denied', 'sign in first', 403);
      const code = `ybac_${deps.random()}`;
      await store.set(C.codes, hashSecret(code), {
        clientId,
        redirectUri,
        codeChallenge,
        resource: clean(resource, 300),
        uid: clean(user.uid, 128),
        email: clean(user.email, 200).toLowerCase(),
        expiresAt: now() + CODE_TTL_MS,
      });
      return { redirect: redirectWith(redirectUri, { code, state: clean(state, 500) }) };
    },

    /** The admin tapped Cancel. */
    async deny({ clientId, redirectUri, state }) {
      await clientFor(clientId, redirectUri);
      return { redirect: redirectWith(redirectUri, { error: 'access_denied', state: clean(state, 500) }) };
    },

    /** The token endpoint. `form` is the request's fields; `basic` the
     *  client id and secret from an Authorization: Basic header, if any. */
    async token(form, basic = null) {
      const f = form && typeof form === 'object' ? form : {};
      const clientId = String(basic?.id || f.client_id || '');
      const c = await client(clientId);
      if (c.authMethod !== 'none') {
        const secret = basic?.secret ?? f.client_secret;
        if (!secret || !sameSecret(hashSecret(secret), c.secretHash)) throw new OAuthError('invalid_client', 'bad client credentials', 401);
      }
      if (f.grant_type === 'authorization_code') {
        const data = f.code ? await store.take(C.codes, hashSecret(f.code)) : null;
        if (!data || data.expiresAt <= now() || data.clientId !== clientId) throw new OAuthError('invalid_grant', 'code is invalid or expired');
        if (String(f.redirect_uri || '') !== data.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
        if (!pkceMatches(f.code_verifier, data.codeChallenge)) throw new OAuthError('invalid_grant', 'code_verifier does not match');
        if (!(await deps.isAllowed(data.email))) throw new OAuthError('invalid_grant', 'not on the access list');
        const grantId = `g_${deps.random()}`.slice(0, 40);
        await store.set(C.grants, grantId, {
          clientId, clientName: c.name, uid: data.uid, email: data.email, createdAt: now(), lastUsedAt: now(),
        });
        return issue(grantId);
      }
      if (f.grant_type === 'refresh_token') {
        const data = f.refresh_token ? await store.take(C.tokens, hashSecret(f.refresh_token)) : null;
        if (!data || data.type !== 'refresh' || data.expiresAt <= now()) throw new OAuthError('invalid_grant', 'refresh token is invalid or expired');
        const grant = await store.get(C.grants, data.grantId);
        if (!grant || grant.clientId !== clientId) throw new OAuthError('invalid_grant', 'this connection was removed');
        if (!(await deps.isAllowed(grant.email))) throw new OAuthError('invalid_grant', 'not on the access list');
        await store.update(C.grants, data.grantId, { lastUsedAt: now() });
        return issue(data.grantId);
      }
      throw new OAuthError('unsupported_grant_type', 'use authorization_code or refresh_token');
    },

    /** RFC 7009: the client signs out. Always succeeds. */
    async revokeToken(token) {
      if (!token) return;
      const data = await store.get(C.tokens, hashSecret(token));
      if (data?.grantId) await this.removeGrant(data.grantId);
    },

    /** An MCP request's bearer token → who it acts for, or null. */
    async verify(accessToken) {
      if (!/^ybat_[A-Za-z0-9_-]{20,100}$/.test(String(accessToken || ''))) return null;
      const data = await store.get(C.tokens, hashSecret(accessToken));
      if (!data || data.type !== 'access' || data.expiresAt <= now()) return null;
      const grant = await store.get(C.grants, data.grantId);
      if (!grant || !(await deps.isAllowed(grant.email))) return null;
      if (!grant.lastUsedAt || now() - grant.lastUsedAt > 10 * 60 * 1000) {
        await store.update(C.grants, data.grantId, { lastUsedAt: now() }).catch(() => {});
      }
      return { uid: grant.uid, email: grant.email, clientName: grant.clientName, grantId: data.grantId };
    },

    /** Connected assistants, for Settings. */
    async listGrants() {
      const rows = await store.query(C.grants, null, null);
      return rows
        .map(({ id, data }) => ({ id, clientName: data.clientName, email: data.email, createdAt: data.createdAt, lastUsedAt: data.lastUsedAt }))
        .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    },

    /** Disconnects one assistant: its tokens stop working at once. */
    async removeGrant(grantId) {
      await store.delete(C.grants, grantId);
      const tokens = await store.query(C.tokens, 'grantId', grantId);
      await Promise.all(tokens.map(({ id }) => store.delete(C.tokens, id)));
    },
  };
}
