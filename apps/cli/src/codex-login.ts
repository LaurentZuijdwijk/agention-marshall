import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { spawn } from 'node:child_process';
import { CODEX_OAUTH, exchangeCodexCode, saveCredentials } from '@agentionai/marshall-engine';
import type { OAuthCredentials } from '@agentionai/marshall-engine';

/**
 * "Sign in with ChatGPT" for the `codex` provider.
 *
 * Unlike the Claude login next door, this one never asks the user to paste
 * anything: OpenAI redirects the browser back to a loopback address, so the CLI
 * listens on it and reads the code straight off the query string. The port is
 * fixed at 1455 because that is what is registered for this client id — it is
 * not a preference we can move.
 *
 * The listener is the security boundary here. A public PKCE client has no
 * secret, so what stops a second process on this machine from completing
 * somebody else's login is: it binds loopback only, it runs for one exchange
 * and then closes, and it refuses any callback whose `state` is not the one
 * this flow generated.
 */

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'rundll32'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  // The URL remains available in the transcript when no graphical opener is
  // installed, so a launch failure must not take down the CLI.
  child.once('error', () => {});
  child.unref();
}

/** Constant-time compare, so a wrong `state` cannot be found a character at a
 *  time by watching how long the rejection takes. */
function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const DONE_PAGE = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Marshall</title>`
  + `<body style="font:16px system-ui;padding:3rem;max-width:32rem"><p>${message}</p></body>`;

export interface CodexLoginSession {
  authUrl: string;
  /** Resolves once the browser has come back and the tokens are saved. */
  completed: Promise<void>;
  /** Stop listening. Safe to call after `completed` settles — used by the UI
   *  when the user gives up, and by tests so a failed assertion cannot leave a
   *  socket bound. */
  cancel: () => void;
}

/** How long the listener stays up before giving the port back. Long enough for
 *  a password manager and a 2FA prompt, short enough not to sit on 1455 for the
 *  rest of the session. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * Start the flow: bind the callback, open the browser, and hand back a promise
 * that settles when the exchange is done.
 *
 * Split this way rather than as one awaited call so the caller can render the
 * URL immediately — the browser may not open at all over SSH, and the user
 * needs something to copy while the listener is already waiting.
 */
export async function startCodexLogin(
  options: { openBrowser?: (url: string) => void; timeoutMs?: number } = {},
): Promise<CodexLoginSession> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));

  let server!: Server;
  let settle!: (err?: Error) => void;
  let timer: NodeJS.Timeout | undefined;
  let finished = false;

  const completed = new Promise<void>((resolve, reject) => {
    settle = (err?: Error) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      // Settled from `close`'s callback, not before it: port 1455 is fixed and
      // shared with the Codex CLI, so "this login is over" has to mean the port
      // is back — otherwise a second `/login openai` in the same session races
      // its own listener and reports the port as in use.
      server.close(() => { if (err) reject(err); else resolve(); });
      // `close()` alone only stops *new* connections; a keep-alive socket the
      // browser (or a test's fetch) is still holding would keep the server, and
      // the process, alive indefinitely.
      server.closeAllConnections();
    };
  });
  // Attached before anything can reject, so a callback that arrives while the
  // caller is still rendering the URL cannot become an unhandled rejection.
  completed.catch(() => {});

  server = createServer((req, res) => {
    // The browser is owed a page either way, and `settle` tears the socket down
    // — so the outcome waits until the body has actually gone out. Otherwise
    // the tab that just authorised shows a connection error.
    const reply = (status: number, message: string, outcome?: Error | null): void => {
      // `Connection: close` on every reply. A browser following a one-shot
      // OAuth redirect has no use for keep-alive, and a pooled socket to a
      // server that is about to shut down is a connection error for whoever
      // reuses it next.
      res.writeHead(status, { 'Content-Type': 'text/html', Connection: 'close' })
        .end(DONE_PAGE(message), () => { if (outcome !== undefined) settle(outcome ?? undefined); });
    };

    const url = new URL(req.url ?? '/', `http://localhost:${CODEX_OAUTH.callbackPort}`);
    if (url.pathname !== CODEX_OAUTH.callbackPath) {
      res.writeHead(404, { Connection: 'close' }).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const returned = url.searchParams.get('state');

    if (!returned || !sameState(returned, state)) {
      // Not this flow's callback. Answered without a hint as to why, and
      // crucially *without* settling: another tab's stale redirect must not be
      // able to cancel the login the user is in the middle of.
      reply(400, 'This sign-in link is not valid here.');
      return;
    }
    if (error) {
      reply(400, 'Sign-in was refused. You can close this tab.',
        new Error(`OpenAI refused the sign-in: ${url.searchParams.get('error_description') ?? error}`));
      return;
    }
    if (!code) {
      reply(400, 'No authorization code came back. You can close this tab.',
        new Error('OpenAI returned no authorization code.'));
      return;
    }

    exchangeCodexCode(code, verifier)
      .then((creds: OAuthCredentials) => {
        saveCredentials('codex', creds);
        reply(200, 'Signed in to Marshall. You can close this tab and go back to the terminal.', null);
      })
      .catch((err: unknown) => {
        reply(500, 'Could not complete sign-in. Check the terminal.',
          err instanceof Error ? err : new Error(String(err)));
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE'
        // Worth naming: the usual cause is a Codex CLI login in another window,
        // and "address in use" on its own sends people looking for the wrong thing.
        ? new Error(`Port ${CODEX_OAUTH.callbackPort} is already in use — OpenAI only accepts `
          + `its callback there. Close any other sign-in that is running and try again.`)
        : err);
    });
    // Loopback only. Binding 0.0.0.0 would put an endpoint that completes a
    // login on the local network.
    server.listen(CODEX_OAUTH.callbackPort, '127.0.0.1', resolve);
  });

  timer = setTimeout(
    () => settle(new Error('Timed out waiting for the browser to come back. Run /login openai to try again.')),
    options.timeoutMs ?? LOGIN_TIMEOUT_MS,
  );
  // Not a reason to hold the process open at exit.
  timer.unref?.();

  const authUrl = `${CODEX_OAUTH.authorizeUrl}?${new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH.clientId,
    redirect_uri: CODEX_OAUTH.redirectUri,
    scope: CODEX_OAUTH.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  (options.openBrowser ?? openBrowser)(authUrl);

  return { authUrl, completed, cancel: () => settle(new Error('Sign-in cancelled.')) };
}
