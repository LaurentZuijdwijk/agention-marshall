import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The pairing token stands between "any webpage" and "drives your browser".
 * The server binds to 127.0.0.1 only, but a loopback port is still reachable
 * from any page's own `fetch`/`WebSocket` running in the browser it's meant
 * to control — the token is what stops a page from pairing with itself.
 *
 * Generated fresh per process, printed once on startup, and never persisted:
 * the user copies it into the extension's options page, and a restarted
 * server means a new token and a re-paste. No auto-discovery for v1.
 */
export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Constant-time so a wrong guess can't be timed toward a right one. */
export function tokensMatch(expected: string, actual: string | undefined | null): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
