import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where OAuth logins are kept, and the one place that knows the file's shape.
 *
 * Lives in the engine rather than the CLI because both ends need it: the CLI
 * writes it at the end of a `/login`, and the engine reads it every time it
 * builds an agent. A second copy of the parsing in `apps/cli` would be a second
 * thing to keep in step with the file on disk.
 *
 * Historically this file held one Claude login as a bare
 * `{ accessToken, refreshToken, expiresAt }` object. That shape still reads —
 * see `readCredentials` — because the alternative is silently signing out
 * everyone who upgrades.
 */

/** Providers Marshall can hold an OAuth login for. Not every `Provider`: the
 *  rest authenticate with an API key and have nothing to store here. */
export type OAuthProvider = 'claude' | 'codex';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch millis. Compared against `Date.now()`, never against a token claim. */
  expiresAt: number;
  /**
   * ChatGPT workspace the token belongs to, read out of the id_token at login.
   * The Codex backend sends it as `chatgpt-account-id` and may reject a request
   * without one; Anthropic has no equivalent, so it is absent for `claude`.
   */
  accountId?: string;
  /** Account e-mail and subscription tier, when the id_token carried them.
   *  Shown in the header so it is obvious which account is being billed. */
  email?: string;
  planType?: string;
}

type CredentialFile = Partial<Record<OAuthProvider, OAuthCredentials>>;

export function credentialsDir(): string {
  return join(process.env.HOME ?? '~', '.marshall');
}

export function credentialsPath(): string {
  return join(credentialsDir(), 'credentials.json');
}

/** Every stored login, keyed by provider. `{}` when there is no file, the file
 *  is unreadable, or its contents are not an object — a corrupt file behaves
 *  like a logged-out one rather than taking the process down. */
export function readAllCredentials(): CredentialFile {
  try {
    const path = credentialsPath();
    if (!existsSync(path)) return {};
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    // The pre-provider shape: one bare Claude login at the top level. Read as
    // `claude` so an existing `marshall login` survives the upgrade; rewritten
    // into the keyed shape the next time anything logs in.
    if ('accessToken' in raw) return { claude: raw as OAuthCredentials };
    return raw as CredentialFile;
  } catch {
    return {};
  }
}

export function readCredentials(provider: OAuthProvider): OAuthCredentials | null {
  const creds = readAllCredentials()[provider];
  return creds?.accessToken ? creds : null;
}

/**
 * Store one provider's login, leaving the others alone.
 *
 * Read-modify-write rather than a whole-file overwrite: logging into OpenAI
 * must not sign the user out of Claude. `0o600` because this file is two
 * bearer tokens.
 */
export function saveCredentials(provider: OAuthProvider, creds: OAuthCredentials): void {
  mkdirSync(credentialsDir(), { recursive: true });
  const next: CredentialFile = { ...readAllCredentials(), [provider]: creds };
  writeFileSync(credentialsPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  // `mode` only applies when creating a file; repair permissions when replacing
  // a legacy or manually-created credential file as well.
  chmodSync(credentialsPath(), 0o600);
}

/** Drop one provider's login. Used by a failed refresh, where keeping the dead
 *  token would mean the same doomed request on every later turn. */
export function clearCredentials(provider: OAuthProvider): void {
  const all = readAllCredentials();
  if (!(provider in all)) return;
  delete all[provider];
  mkdirSync(credentialsDir(), { recursive: true });
  writeFileSync(credentialsPath(), JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(credentialsPath(), 0o600);
}

/**
 * A minute's grace, so a token that will die mid-request counts as expired now.
 *
 * The alternative is a request that passes the check, spends its round trip and
 * comes back 401 — which is the same refresh, one failure later.
 */
export const EXPIRY_GRACE_MS = 60_000;

export function isExpired(creds: OAuthCredentials, now = Date.now()): boolean {
  return now > creds.expiresAt - EXPIRY_GRACE_MS;
}
