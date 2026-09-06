// Background service worker: holds the WebSocket connection to
// marshall-plugin-browser's /bridge endpoint and dispatches each relayed
// command to chrome.tabs/chrome.scripting against the active tab.
//
// MV3 service workers are evicted after ~30s idle, which would otherwise
// drop the WebSocket silently. A chrome.alarms keepalive re-invokes this
// script periodically, and `connect()` is idempotent (a no-op when already
// open or connecting), so waking up just re-affirms the connection rather
// than duplicating it.
import type { BridgeCommand } from './protocol.js';
import { DRAIN_CONSOLE_LOGS } from './protocol.js';

const KEEPALIVE_ALARM = 'marshall-keepalive';
const RECONNECT_DELAY_MS = 3_000;
const NAVIGATE_TIMEOUT_MS = 15_000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

interface PairingConfig {
  bridgeUrl: string;
  token: string;
}

async function getConfig(): Promise<PairingConfig | null> {
  const { bridgeUrl, token, enabled } = await chrome.storage.local.get(['bridgeUrl', 'token', 'enabled']);
  if (enabled === false) return null;
  if (!bridgeUrl || !token) return null;
  return { bridgeUrl, token };
}

async function setStatus(status: string): Promise<void> {
  await chrome.storage.local.set({ status });
}

async function connect(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const { enabled } = await chrome.storage.local.get(['enabled']);
  if (enabled === false) {
    await setStatus('disabled');
    return;
  }

  const config = await getConfig();
  if (!config) {
    await setStatus('not paired — click the extension icon to pair');
    return;
  }

  const socket = new WebSocket(`${config.bridgeUrl}?token=${encodeURIComponent(config.token)}`);
  ws = socket;

  socket.addEventListener('open', () => { void setStatus('connected'); });
  socket.addEventListener('close', () => {
    if (ws === socket) ws = null;
    void (async () => {
      // A deliberate Disable (popup) closes the socket too — this is what
      // stops that from immediately relabelling itself "retrying" and then
      // actually retrying a few seconds later.
      const { enabled: stillEnabled } = await chrome.storage.local.get(['enabled']);
      if (stillEnabled === false) {
        await setStatus('disabled');
        return;
      }
      await setStatus('disconnected — retrying');
      scheduleReconnect();
    })();
  });
  socket.addEventListener('error', () => { /* 'close' always follows */ });
  socket.addEventListener('message', (event) => { void handleMessage(String(event.data), socket); });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, RECONNECT_DELAY_MS);
}

async function handleMessage(raw: string, socket: WebSocket): Promise<void> {
  let command: BridgeCommand;
  try {
    command = JSON.parse(raw);
  } catch {
    return; // Not a command we understand.
  }
  try {
    const result = await runCommand(command);
    socket.send(JSON.stringify({ id: command.id, ok: true, result }));
  } catch (err) {
    socket.send(JSON.stringify({
      id: command.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab — open a tab in the browser Chrome is running');
  return tab;
}

const MARSHALL_GROUP_TITLE = 'Marshall';
const MARSHALL_GROUP_COLOR: chrome.tabGroups.ColorEnum = 'purple';

/** Fire-and-forget — a page with no content script (chrome://, the Web Store,
 *  a page that hasn't finished loading yet) has nothing to show it on, and
 *  that's not an error worth surfacing to the model. */
function showOverlay(tabId: number): void {
  void chrome.tabs.sendMessage(tabId, { type: 'show_overlay' }).catch(() => {});
}

/** Awaited, unlike showOverlay: the caller needs the removal to have actually
 *  painted before it captures anything. */
async function hideOverlayAndWaitPaint(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'hide_overlay' });
  } catch {
    // No overlay content script on this page — nothing to hide.
  }
}

/**
 * Puts a tab into the (window-scoped) "Marshall" tab group the first time
 * Marshall acts on it, colouring it in the tab strip itself — visible even
 * when the tab isn't focused, unlike the in-page overlay. Never touches a
 * tab that's already in some group: fighting the user's own organisation
 * would be a worse outcome than an ungrouped tab. Left grouped once joined
 * — a live join/leave in sync with every enable/disable is more machinery
 * than the visual cue is worth.
 */
async function ensureGrouped(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  if (tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  const existing = await chrome.tabGroups.query({ windowId: tab.windowId, title: MARSHALL_GROUP_TITLE });
  if (existing[0]) {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: existing[0].id });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: MARSHALL_GROUP_TITLE, color: MARSHALL_GROUP_COLOR });
}

/** The in-page overlay plus the tab-strip colour — both are "Marshall is
 *  acting on this tab", just at different scales. Fire-and-forget like
 *  showOverlay: neither is worth blocking a command on, and a page/tab that
 *  can't be marked (chrome://, a group the user already made) isn't an
 *  error the model needs to hear about. */
function markTabControlled(tab: chrome.tabs.Tab): void {
  showOverlay(tab.id!);
  void ensureGrouped(tab).catch(() => {});
}

async function runCommand(command: BridgeCommand): Promise<unknown> {
  const tab = await activeTab();
  switch (command.type) {
    case 'navigate':
      return navigate(tab, String(command.params.url));
    case 'screenshot':
      return screenshot(tab);
    case 'click':
      markTabControlled(tab);
      return click(tab, String(command.params.selector));
    case 'type':
      markTabControlled(tab);
      return typeInto(tab, String(command.params.selector), String(command.params.text));
    case 'read_page':
      markTabControlled(tab);
      return readPage(tab, command.params.format === 'html' ? 'html' : 'text');
    case 'console_logs':
      markTabControlled(tab);
      return consoleLogs(tab);
    default:
      throw new Error(`unknown command "${(command as { type?: string }).type}"`);
  }
}

async function navigate(tab: chrome.tabs.Tab, url: string): Promise<Record<string, never>> {
  await chrome.tabs.update(tab.id!, { url });
  await waitForLoad(tab.id!);
  // After the load, not before: the previous page's content script (and its
  // overlay) is gone the moment the navigation starts. The tab group survives
  // a navigation (it's a tab-level property, not a page-level one), so this
  // still only creates one the very first time.
  markTabControlled(tab);
  return {};
}

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, NAVIGATE_TIMEOUT_MS);
    function onUpdated(id: number, info: chrome.tabs.TabChangeInfo): void {
      if (id === tabId && info.status === 'complete') finish();
    }
    function finish(): void {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function screenshot(tab: chrome.tabs.Tab): Promise<{ data: string; mimeType: string; url?: string; title?: string }> {
  await hideOverlayAndWaitPaint(tab.id!);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const data = dataUrl.split(',')[1] ?? '';
  markTabControlled(tab);
  return { data, mimeType: 'image/png', url: tab.url, title: tab.title };
}

interface ScriptOutcome { ok: boolean; error?: string }

async function click(tab: chrome.tabs.Tab, selector: string): Promise<Record<string, never>> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: (sel: string): ScriptOutcome => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { ok: false, error: `no element matches "${sel}"` };
      el.click();
      return { ok: true };
    },
    args: [selector],
  });
  if (!result?.ok) throw new Error(result?.error ?? 'click failed');
  return {};
}

async function typeInto(tab: chrome.tabs.Tab, selector: string, text: string): Promise<Record<string, never>> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: (sel: string, value: string): ScriptOutcome => {
      const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) return { ok: false, error: `no element matches "${sel}"` };
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    },
    args: [selector, text],
  });
  if (!result?.ok) throw new Error(result?.error ?? 'type failed');
  return {};
}

async function readPage(
  tab: chrome.tabs.Tab,
  format: 'text' | 'html',
): Promise<{ text: string; url?: string; title?: string }> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: (fmt: 'text' | 'html'): string => {
      if (fmt === 'html') return document.documentElement.outerHTML;
      const raw = document.body?.innerText ?? '';
      // innerText alone leaves trailing spaces and can pile up blank lines
      // from stacked block elements — real token savings, not just a format
      // change, is the point of the 'text' mode.
      return raw
        .split('\n')
        .map(line => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
    },
    args: [format],
  });
  return { text: String(result ?? ''), url: tab.url, title: tab.title };
}

async function consoleLogs(tab: chrome.tabs.Tab): Promise<{ logs: unknown[] }> {
  try {
    return await chrome.tabs.sendMessage(tab.id!, { type: DRAIN_CONSOLE_LOGS });
  } catch {
    // No relay content script on this page (e.g. chrome:// URLs) — an empty
    // log, not a thrown error, since "nothing captured" is a real answer.
    return { logs: [] };
  }
}

/** Closes every tab in the "Marshall" group(s) — the popup's "Close tabs"
 *  button. Closing a tab drops it from its group automatically, so there's
 *  nothing else to clean up. Returns how many were actually closed. */
async function closeMarshallTabs(): Promise<number> {
  const groups = await chrome.tabGroups.query({ title: MARSHALL_GROUP_TITLE });
  let closed = 0;
  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const ids = tabs.map(t => t.id).filter((id): id is number => id !== undefined);
    if (ids.length === 0) continue;
    await chrome.tabs.remove(ids);
    closed += ids.length;
  }
  return closed;
}

// Messages from the popup — content scripts use this same event, but never
// send a `type` this handler recognises, so returning false for anything
// else lets Chrome know no listener here will call sendResponse for it.
chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type === 'close_marshall_tabs') {
    void closeMarshallTabs().then(closed => sendResponse({ closed }));
    return true;
  }
  return false;
});

// Only chrome.alarms.create() here, not another connect() — the script body
// runs (and its unconditional connect() at the bottom fires) every time the
// service worker starts, install included, so onInstalled/onStartup calling
// connect() too used to race a second one in on a fresh install: both calls'
// synchronous halves would pass the `ws` guard before either had gotten far
// enough to actually assign it, opening two sockets to the bridge server.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void connect();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.bridgeUrl || changes.token || changes.enabled)) {
    ws?.close();
    void connect();
  }
});

void connect();
