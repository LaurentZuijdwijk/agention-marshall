import {
  CODEX_CLIENT_ID, CODEX_TOKEN_URL, decodeJwtClaims, jwtExpiry, loadCodexCredentials,
} from '@agentionai/agents/openai';
import type { CodexCredentials } from '@agentionai/agents/openai';
import { readCredentials, saveCredentials } from './oauth-store.js';
import type { OAuthCredentials } from './oauth-store.js';

/**
 * The half of "sign in with ChatGPT" the SDK does not do.
 *
 * `@agentionai/agents/openai` owns everything after a token exists: the
 * transport (`CodexAgent`), the refresh (`createCodexTokenProvider`), the
 * account header, the model catalogue. What it deliberately does not own is the
 * *interactive* flow — `loadCodexCredentials` only reads what `codex login`
 * already wrote. This module is that missing step: the PKCE authorization-code
 * exchange, so Marshall can sign someone in without the Codex CLI installed.
 *
 * Everything here is derived from the Codex CLI's own behaviour and is not a
 * documented API — the same caveat the SDK states.
 */
export const CODEX_OAUTH = {
  clientId: CODEX_CLIENT_ID,
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: CODEX_TOKEN_URL,
  /** Registered against this client id — the port is not ours to choose. */
  redirectUri: 'http://localhost:1455/auth/callback',
  callbackPort: 1455,
  callbackPath: '/auth/callback',
  scopes: 'openid profile email offline_access',
} as const;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface CodexIdClaims {
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
  chatgpt_account_id?: string;
  email?: string;
}

/**
 * Pull the account claims out of a login response.
 *
 * The account id is the one that matters: the Codex backend bills against it
 * and may refuse a request that names none. `decodeJwtClaims` comes from the
 * SDK so there is one JWT reader rather than two that can disagree.
 */
export function claimsFrom(idToken: string | undefined): Pick<OAuthCredentials, 'accountId' | 'email' | 'planType'> {
  if (!idToken) return {};
  const claims = decodeJwtClaims<CodexIdClaims>(idToken);
  if (!claims) return {};
  const scoped = claims['https://api.openai.com/auth'];
  const accountId = scoped?.chatgpt_account_id ?? claims.chatgpt_account_id;
  return {
    ...(accountId ? { accountId } : {}),
    ...(claims.email ? { email: claims.email } : {}),
    ...(scoped?.chatgpt_plan_type ? { planType: scoped.chatgpt_plan_type } : {}),
  };
}

/**
 * When the access token runs out, in epoch millis.
 *
 * The token's own `exp` claim is preferred over `expires_in`: it is what the
 * backend will actually enforce, and it does not drift with however long the
 * response spent in transit. `expires_in` is the fallback for an opaque token,
 * and an hour is the fallback for neither — a slightly early refresh costs one
 * request, while a missing expiry would mean never refreshing at all.
 */
export function expiryOf(data: TokenResponse, now = Date.now()): number {
  const claimed = jwtExpiry(data.access_token);
  if (claimed) return claimed * 1000;
  return now + (data.expires_in ?? 3600) * 1000;
}

export function toCredentials(data: TokenResponse, previous?: OAuthCredentials): OAuthCredentials {
  const claims = claimsFrom(data.id_token);
  return {
    accessToken: data.access_token,
    // A refresh response need not rotate the refresh token; dropping the old
    // one when it doesn't would sign the user out at the next expiry instead.
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? '',
    expiresAt: expiryOf(data),
    ...(previous?.accountId ? { accountId: previous.accountId } : {}),
    ...(previous?.email ? { email: previous.email } : {}),
    ...(previous?.planType ? { planType: previous.planType } : {}),
    ...claims,
  };
}

/**
 * Exchange the authorization code the loopback callback captured.
 *
 * Form-encoded per RFC 6749 §4.1.3. There is no client secret — this is a
 * public client, which is what the PKCE verifier is standing in for.
 */
export async function exchangeCodexCode(code: string, verifier: string): Promise<OAuthCredentials> {
  const res = await fetch(CODEX_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_OAUTH.clientId,
      code,
      redirect_uri: CODEX_OAUTH.redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Codex token exchange failed (${res.status}): ${await res.text()}`);
  return toCredentials(await res.json() as TokenResponse);
}

/** Our stored shape, as the SDK's agent wants it. */
export function toCodexCredentials(creds: OAuthCredentials): CodexCredentials {
  return {
    accessToken: creds.accessToken,
    ...(creds.refreshToken ? { refreshToken: creds.refreshToken } : {}),
    ...(creds.accountId ? { accountId: creds.accountId } : {}),
    ...(creds.email ? { email: creds.email } : {}),
    ...(creds.planType ? { planType: creds.planType } : {}),
  };
}

/** The SDK's shape, as we store it. Used by both the login and the import. */
export function fromCodexCredentials(creds: CodexCredentials, now = Date.now()): OAuthCredentials {
  const claimed = jwtExpiry(creds.accessToken);
  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken ?? '',
    // A token read from someone else's file carries no `expires_in`, so its own
    // `exp` claim is all there is. Treated as already expired when it has
    // neither, which makes the first request refresh rather than 401.
    expiresAt: claimed ? claimed * 1000 : now,
    ...(creds.accountId ? { accountId: creds.accountId } : {}),
    ...(creds.email ? { email: creds.email } : {}),
    ...(creds.planType ? { planType: creds.planType } : {}),
  };
}

/**
 * Adopt an existing `codex login` from `~/.codex/auth.json`.
 *
 * Offered because it is free — the SDK already reads that file — and it saves a
 * browser round trip for the many people who have the Codex CLI installed.
 * Returns `null` rather than throwing when there is nothing to import, since
 * "no Codex CLI here" is the ordinary case, not a failure.
 */
export async function importCodexCliLogin(codexHome?: string): Promise<OAuthCredentials | null> {
  try {
    const imported = fromCodexCredentials(await loadCodexCredentials(codexHome));
    if (!imported.accessToken) return null;
    saveCredentials('codex', imported);
    return imported;
  } catch {
    return null;
  }
}

/** The stored Codex login, or `null`. Does not consider expiry: the SDK's token
 *  provider refreshes on demand, so an aged token is still a usable login. */
export function codexCredentials(): OAuthCredentials | null {
  return readCredentials('codex');
}
