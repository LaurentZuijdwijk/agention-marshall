import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { tokensMatch } from './token.js';

/** Default ceiling on a relayed call — the extension is a browser tab away, not a network hop. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Relays browser commands to the Chrome extension over a loopback WebSocket
 * and matches responses back to their caller.
 *
 * One extension connection at a time — a new connection replaces the old
 * one, on the assumption that a re-pairing (extension reload, browser
 * restart) is a replacement, not a second browser to fan out to. Multi-
 * browser support is out of scope for v1.
 */
export class ExtensionBridge {
  private readonly wss: WebSocketServer;
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(private readonly token: string) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  /** Called from the HTTP server's `upgrade` event for the `/bridge` path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (!tokensMatch(this.token, url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws));
  }

  private onConnection(ws: WebSocket): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = ws;
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => { if (this.ws === ws) this.ws = null; });
    ws.on('error', () => { /* 'close' follows; nothing more to do here */ });
  }

  private onMessage(data: RawData): void {
    let msg: { id?: string; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // Not a response we understand — ignore rather than crash the bridge.
    }
    if (!msg.id) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return; // Already timed out, or not ours.
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error ?? 'the extension reported an error with no message'));
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Send one command to the extension and wait for its matching response. */
  call(type: string, params: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error(
        'no browser extension connected — open Chrome, load the extension, and pair it with this server',
      ));
    }
    const ws = this.ws;
    const id = `${Date.now()}-${this.seq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the extension did not respond within ${(timeoutMs / 1000).toFixed(0)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, type, params }));
    });
  }

  /** Reject every in-flight call and drop the connection — used on shutdown. */
  close(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('the bridge server is shutting down'));
      this.pending.delete(id);
    }
    this.ws?.close();
    this.wss.close();
  }
}
