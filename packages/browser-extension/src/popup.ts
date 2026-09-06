// The toolbar-icon popup: pairing (so it's not buried in a separate options
// page), live connection status, and the two things worth a one-click
// action — pause the connection, and clean up after a session by closing
// whatever tabs Marshall touched.
const dot = document.getElementById('dot') as HTMLElement;
const statusText = document.getElementById('statusText') as HTMLElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const toggleButton = document.getElementById('toggle') as HTMLButtonElement;
const closeTabsButton = document.getElementById('closeTabs') as HTMLButtonElement;
const feedback = document.getElementById('feedback') as HTMLElement;

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8712/bridge';

function classify(status: string): string {
  if (status.startsWith('connected')) return 'connected';
  if (status.startsWith('not paired') || status.startsWith('disconnected')) return 'pending';
  return 'error'; // 'disabled', a bridge error, anything else
}

function render(status: string | undefined, enabled: boolean): void {
  const text = status ?? 'not paired';
  statusText.textContent = text;
  dot.className = `dot ${classify(text)}`;
  toggleButton.textContent = enabled ? 'Disable' : 'Enable';
}

async function load(): Promise<void> {
  const { bridgeUrl, token, status, enabled } = await chrome.storage.local.get(['bridgeUrl', 'token', 'status', 'enabled']);
  tokenInput.value = token ?? '';
  urlInput.value = bridgeUrl ?? DEFAULT_BRIDGE_URL;
  render(status, enabled !== false);
}

saveButton.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  if (!token) {
    feedback.textContent = 'paste a token first';
    return;
  }
  // Saving is also an implicit re-enable — pasting a fresh token while
  // disabled and having nothing happen would be a confusing dead end.
  void chrome.storage.local.set({
    bridgeUrl: urlInput.value.trim() || DEFAULT_BRIDGE_URL,
    token,
    enabled: true,
  }).then(() => { feedback.textContent = 'saved — connecting…'; });
});

toggleButton.addEventListener('click', async () => {
  const { enabled } = await chrome.storage.local.get(['enabled']);
  const next = enabled === false;
  await chrome.storage.local.set({ enabled: next });
  feedback.textContent = next ? 'connecting…' : 'disabled';
});

closeTabsButton.addEventListener('click', () => {
  feedback.textContent = 'closing…';
  chrome.runtime.sendMessage({ type: 'close_marshall_tabs' }, (response: { closed?: number } | undefined) => {
    const closed = response?.closed ?? 0;
    feedback.textContent = closed > 0 ? `closed ${closed} tab${closed === 1 ? '' : 's'}` : 'no Marshall tabs open';
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.status && !changes.enabled)) return;
  void chrome.storage.local.get(['status', 'enabled']).then(
    ({ status, enabled }) => render(status, enabled !== false),
  );
});

void load();
