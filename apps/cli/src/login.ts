import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

export const CREDENTIALS_PATH = join(process.env.HOME ?? '~', '.marshall', 'credentials.json');

export interface MarshallCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

async function exchangeCode(code: string, verifier: string, state: string): Promise<MarshallCredentials> {
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    state,
  });

  let res!: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 5000));
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'anthropic' },
      body,
    });
    if (res.status !== 429) break;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export function saveCredentials(creds: MarshallCredentials): void {
  const dir = join(process.env.HOME ?? '~', '.marshall');
  mkdirSync(dir, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function readCredentials(): MarshallCredentials | null {
  try {
    if (!existsSync(CREDENTIALS_PATH)) return null;
    return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8')) as MarshallCredentials;
  } catch {
    return null;
  }
}

export async function refreshCredentials(creds: MarshallCredentials): Promise<MarshallCredentials> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: creds.refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }
  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export interface LoginSession {
  verifier: string;
  state: string;
  authUrl: string;
}

/** Step 1 — generate PKCE, build the auth URL, open the browser. Returns session state to pass to completeLogin(). */
export function startLogin(): LoginSession {
  const { verifier, challenge } = generatePKCE();
  const state = verifier; // Anthropic convention: state = verifier

  const authParams = new URLSearchParams({
    code: 'true',
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const authUrl = `${AUTH_URL}?${authParams}`;
  openBrowser(authUrl);
  return { verifier, state, authUrl };
}

/** Step 2 — exchange the code the user pasted for tokens and save them. */
export async function completeLogin(raw: string, session: LoginSession): Promise<void> {
  // Code may arrive as "CODE#STATE" — strip the state fragment.
  const code = raw.split('#')[0].trim();
  if (!code) throw new Error('No code provided.');
  const creds = await exchangeCode(code, session.verifier, session.state);
  saveCredentials(creds);
}
