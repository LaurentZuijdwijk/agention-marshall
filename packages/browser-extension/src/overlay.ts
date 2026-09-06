// Isolated-world content script: an in-page "Marshall is driving this tab"
// indicator — a pulsing border around the viewport plus a small text badge —
// rendered into a closed Shadow DOM so the page's CSS can't leak in (or the
// indicator's out). Toggled by background.ts via runtime messages — this
// script has no opinion on *when* it should be visible, only *how*.
const HOST_ID = '__marshall_overlay_host__';
const GLOW_COLOR = '124, 92, 255'; // violet — reads as deliberately artificial, not a page accent

function ensureHost(): { host: HTMLDivElement; shadow: ShadowRoot } {
  const existing = document.getElementById(HOST_ID) as (HTMLDivElement & { _marshallShadow?: ShadowRoot }) | null;
  if (existing?._marshallShadow) return { host: existing, shadow: existing._marshallShadow };

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    @keyframes marshall-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
    .glow {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
      border: 4px solid rgba(${GLOW_COLOR}, 0.9);
      box-shadow: inset 0 0 24px 4px rgba(${GLOW_COLOR}, 0.6), 0 0 18px 2px rgba(${GLOW_COLOR}, 0.5);
      animation: marshall-pulse 2.2s ease-in-out infinite;
    }
    .badge {
      position: fixed;
      bottom: 12px;
      right: 12px;
      z-index: 2147483647;
      background: #111;
      color: #fff;
      font: 12px system-ui, sans-serif;
      padding: 6px 10px;
      border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .35);
      pointer-events: none;
      opacity: 0.9;
    }
  `;
  shadow.appendChild(style);

  const glow = document.createElement('div');
  glow.className = 'glow';
  shadow.appendChild(glow);

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = '🤖 Marshall is controlling this tab';
  shadow.appendChild(badge);

  (host as HTMLDivElement & { _marshallShadow?: ShadowRoot })._marshallShadow = shadow;
  host.style.display = 'none'; // hidden until the first show_overlay
  return { host, shadow };
}

function setVisible(visible: boolean): void {
  ensureHost().host.style.display = visible ? 'block' : 'none';
}

/** Two frames, not a guessed delay — the reply only comes back once the
 *  removal has actually been painted, which is what makes a screenshot taken
 *  right after actually miss the indicator. */
function waitTwoFrames(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type === 'show_overlay') {
    setVisible(true);
    return false;
  }
  if (message?.type === 'hide_overlay') {
    setVisible(false);
    void waitTwoFrames().then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async sendResponse
  }
  return false;
});
