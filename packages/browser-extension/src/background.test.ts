// background.ts runs its top-level `void connect()` on import and talks
// directly to the `chrome.*`/`WebSocket` globals — there is no real browser
// in this environment to load an unpacked extension into, so this fakes both
// globals and drives the module the way the real bridge server and a real
// page would: a WebSocket command in, chrome.tabs/scripting calls out, a
// BridgeResponse back. What a click/type command's *injected function* does
// once it actually runs inside a page is not re-tested here — that would
// need a real DOM, and the function bodies are short enough to review
// directly in background.ts. What's verified is that our dispatch calls
// chrome.scripting.executeScript with the right target/args in the first
// place, and that the response protocol matches what bridge.ts expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface FakeWebSocketInstance {
  url: string;
  readyState: number;
  listeners: Record<string, ((event: any) => void)[]>;
  sent: string[];
  addEventListener(type: string, handler: (event: any) => void): void;
  send(data: string): void;
  close(): void;
  emit(type: string, event?: any): void;
}

function installFakes() {
  const created: FakeWebSocketInstance[] = [];

  class FakeWebSocket implements FakeWebSocketInstance {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    url: string;
    readyState = FakeWebSocket.CONNECTING;
    listeners: Record<string, ((event: any) => void)[]> = {};
    sent: string[] = [];
    constructor(url: string) {
      this.url = url;
      created.push(this);
    }
    addEventListener(type: string, handler: (event: any) => void): void {
      (this.listeners[type] ??= []).push(handler);
    }
    send(data: string): void { this.sent.push(data); }
    close(): void { this.readyState = FakeWebSocket.CLOSED; this.emit('close'); }
    emit(type: string, event: any = {}): void {
      for (const handler of this.listeners[type] ?? []) handler(event);
    }
  }
  (globalThis as any).WebSocket = FakeWebSocket;

  const storage: Record<string, unknown> = {};
  const storageListeners: ((changes: Record<string, { newValue: unknown }>, area: string) => void)[] = [];
  const executeScriptCalls: any[] = [];
  const tabUpdateCalls: any[] = [];
  const tabsSendMessageCalls: any[] = [];
  const groupCalls: any[] = [];
  const tabGroupsUpdateCalls: any[] = [];
  /** Ordered log of side-effecting calls, for asserting relative timing
   *  (e.g. hide_overlay happens before captureVisibleTab). */
  const callOrder: string[] = [];
  let alarmHandler: ((alarm: { name: string }) => void) | null = null;
  let onUpdatedListener: ((id: number, info: any) => void) | null = null;
  /** -1 (TAB_GROUP_ID_NONE) by default, like a real ungrouped tab — tests
   *  override via activeTabGroupId to simulate an already-grouped tab. */
  let activeTabGroupId = -1;
  let nextGroupId = 100;
  const existingGroups: { id: number; windowId: number; title?: string }[] = [];
  const tabsRemoveCalls: number[][] = [];
  let runtimeMessageListener: ((message: any, sender: any, sendResponse: (r: any) => void) => boolean | void) | null = null;

  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.map(k => [k, storage[k]])),
        set: async (values: Record<string, unknown>) => { Object.assign(storage, values); },
      },
      onChanged: { addListener: (fn: any) => storageListeners.push(fn) },
    },
    tabs: {
      query: async () => [{ id: 1, windowId: 7, url: 'https://example.com', title: 'Example', groupId: activeTabGroupId }],
      update: async (id: number, info: any) => { tabUpdateCalls.push({ id, info }); },
      captureVisibleTab: async () => { callOrder.push('captureVisibleTab'); return 'data:image/png;base64,ZmFrZQ=='; },
      group: async (opts: { tabIds: number[]; groupId?: number }) => {
        groupCalls.push(opts);
        const groupId = opts.groupId ?? nextGroupId++;
        if (opts.groupId === undefined) existingGroups.push({ id: groupId, windowId: 7 });
        activeTabGroupId = groupId;
        return groupId;
      },
      onUpdated: {
        addListener: (fn: any) => { onUpdatedListener = fn; },
        removeListener: () => { onUpdatedListener = null; },
      },
      sendMessage: async (id: number, message: any) => {
        tabsSendMessageCalls.push({ id, message });
        callOrder.push(`sendMessage:${message?.type}`);
        if (message?.type === 'drain_console_logs') return { logs: [{ level: 'log', text: 'hi' }] };
        return { ok: true };
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async (queryInfo: { windowId?: number; title?: string }) =>
        existingGroups.filter(g => (queryInfo.title === undefined || g.title === queryInfo.title)
          && (queryInfo.windowId === undefined || g.windowId === queryInfo.windowId)),
      update: async (groupId: number, props: { title?: string; color?: string }) => {
        tabGroupsUpdateCalls.push({ groupId, props });
        const group = existingGroups.find(g => g.id === groupId);
        if (group) group.title = props.title;
      },
    },
    scripting: {
      executeScript: async (opts: any) => {
        executeScriptCalls.push(opts);
        return [{ result: { ok: true } }];
      },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: (fn: any) => { alarmHandler = fn; } },
    },
    runtime: {
      onInstalled: { addListener: (fn: any) => fn() },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (fn: any) => { runtimeMessageListener = fn; } },
      sendMessage: async () => undefined,
    },
  };
  (globalThis as any).chrome.tabs.remove = async (ids: number[]) => { tabsRemoveCalls.push(ids); };

  return {
    created, storage, executeScriptCalls, tabUpdateCalls, tabsSendMessageCalls, callOrder,
    groupCalls, tabGroupsUpdateCalls, tabsRemoveCalls,
    /** Drives background.ts's own chrome.runtime.onMessage listener — the
     *  same channel a real popup's chrome.runtime.sendMessage lands on. */
    fireRuntimeMessage: (message: any): Promise<any> => new Promise((resolve) => {
      const keepChannelOpen = runtimeMessageListener?.(message, {}, resolve);
      if (!keepChannelOpen) resolve(undefined);
    }),
    setActiveTabGroupId: (id: number) => { activeTabGroupId = id; },
    /** Drives background.ts's own chrome.storage.onChanged listener, the
     *  same way a real write from the popup (a different extension page)
     *  would — a same-process chrome.storage.local.set() does not fire it. */
    emitStorageChange: (changes: Record<string, { newValue: unknown }>) => {
      for (const fn of storageListeners) fn(changes, 'local');
    },
    fireUpdated: (id: number, info: any) => onUpdatedListener?.(id, info),
  };
}

async function loadBackground() {
  // Cache-bust: importing background.ts twice in one process would reuse the
  // first module's top-level `connect()` state.
  return import(`./background.ts?t=${Date.now()}-${Math.random()}`);
}

test('with no pairing config, connect() does not open a socket', async () => {
  const fakes = installFakes();
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fakes.created.length, 0);
});

// Regression: onInstalled used to also call connect(), racing the
// unconditional one at the bottom of the file — on a fresh install (which is
// exactly when onInstalled fires) both would pass the `ws` guard before
// either had actually assigned it, opening two sockets to the bridge server.
test('a fresh install (onInstalled firing) opens exactly one socket, not two', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fakes.created.length, 1);
});

test('enabled: false stops connect() even with a valid pairing config, and reports "disabled"', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok', enabled: false });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fakes.created.length, 0);
  assert.equal(fakes.storage.status, 'disabled');
});

test('flipping enabled to true (e.g. from the popup) triggers a connection', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok', enabled: false });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fakes.created.length, 0);

  fakes.storage.enabled = true;
  fakes.emitStorageChange({ enabled: { newValue: true } });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(fakes.created.length, 1);
});

test('flipping enabled to false closes an open connection and does not schedule a retry', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  assert.equal(fakes.storage.status, 'connected');

  fakes.storage.enabled = false;
  fakes.emitStorageChange({ enabled: { newValue: false } });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(fakes.storage.status, 'disabled');
  assert.equal(fakes.created.length, 1, 'no reconnect attempt should have opened a second socket');
});

test('close_marshall_tabs closes every tab in the group and reports how many', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  // Groups the (single fake) active tab first, so there's something to close.
  socket.emit('message', { data: JSON.stringify({ id: 'p1', type: 'click', params: { selector: '#go' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  const response = await fakes.fireRuntimeMessage({ type: 'close_marshall_tabs' });
  assert.deepEqual(response, { closed: 1 });
  assert.deepEqual(fakes.tabsRemoveCalls, [[1]]);
});

test('close_marshall_tabs reports zero when nothing is grouped', async () => {
  const fakes = installFakes();
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const response = await fakes.fireRuntimeMessage({ type: 'close_marshall_tabs' });
  assert.deepEqual(response, { closed: 0 });
  assert.deepEqual(fakes.tabsRemoveCalls, []);
});

test('a navigate command updates the active tab and waits for it to finish loading', async (t) => {
  const fakes = installFakes();
  await fakes.storage as any;
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'c1', type: 'navigate', params: { url: 'https://x.test' } }) });

  // navigate() awaits chrome.tabs.update before registering the onUpdated
  // listener waitForLoad() waits on — give those microtasks room to run
  // before firing the event that resolves it.
  await new Promise(resolve => setTimeout(resolve, 10));
  fakes.fireUpdated(1, { status: 'complete' });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(fakes.tabUpdateCalls, [{ id: 1, info: { url: 'https://x.test' } }]);
  const response = JSON.parse(socket.sent.at(-1)!);
  assert.deepEqual(response, { id: 'c1', ok: true, result: {} });
});

test('a screenshot command returns base64 data stripped of the data: prefix', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'c2', type: 'screenshot', params: {} }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  const response = JSON.parse(socket.sent.at(-1)!);
  assert.equal(response.ok, true);
  assert.equal(response.result.data, 'ZmFrZQ==');
  assert.equal(response.result.mimeType, 'image/png');
  assert.equal(response.result.url, 'https://example.com');
});

test('a click command calls executeScript with the selector as an argument', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'c3', type: 'click', params: { selector: '#go' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(fakes.executeScriptCalls.length, 1);
  assert.deepEqual(fakes.executeScriptCalls[0].args, ['#go']);
  assert.deepEqual(fakes.executeScriptCalls[0].target, { tabId: 1 });
  const response = JSON.parse(socket.sent.at(-1)!);
  assert.equal(response.ok, true);
});

test('press_key calls executeScript with the selector, key and modifiers as arguments', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', {
    data: JSON.stringify({ id: 'k1', type: 'press_key', params: { selector: '#q', key: 'Enter', ctrlKey: true } }),
  });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(fakes.executeScriptCalls.length, 1);
  assert.equal(fakes.executeScriptCalls[0].func.name, 'dispatchKeyPress');
  assert.deepEqual(
    fakes.executeScriptCalls[0].args,
    ['#q', 'Enter', { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }],
  );
  const response = JSON.parse(socket.sent.at(-1)!);
  assert.equal(response.ok, true);
});

test('press_key with no selector still forwards undefined, not a stray string', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'k2', type: 'press_key', params: { key: 'Escape' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(
    fakes.executeScriptCalls[0].args,
    [undefined, 'Escape', { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }],
  );
});

test('console_logs relays through tabs.sendMessage to the content-script relay', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'c4', type: 'console_logs', params: {} }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.ok(fakes.tabsSendMessageCalls.some(c => c.message.type === 'drain_console_logs'));
  const response = JSON.parse(socket.sent.at(-1)!);
  assert.deepEqual(response.result.logs, [{ level: 'log', text: 'hi' }]);
});

test('read_page passes the requested format through to executeScript, defaulting to markdown', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'r1', type: 'read_page', params: {} }) });
  await new Promise(resolve => setTimeout(resolve, 10));
  socket.emit('message', { data: JSON.stringify({ id: 'r2', type: 'read_page', params: { format: 'html' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));
  socket.emit('message', { data: JSON.stringify({ id: 'r3', type: 'read_page', params: { format: 'text' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  // readPage injects one of three named, argument-free extractor functions
  // (see page-scripts.ts) rather than an inline func taking a format
  // argument — asserting on the function's own name is what distinguishes
  // them here.
  assert.equal(fakes.executeScriptCalls[0].func.name, 'extractMarkdown');
  assert.equal(fakes.executeScriptCalls[1].func.name, 'extractHtml');
  assert.equal(fakes.executeScriptCalls[2].func.name, 'extractText');
});

test('click/type/press_key/read_page/console_logs show the overlay on the active tab', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'o1', type: 'click', params: { selector: '#go' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.ok(fakes.tabsSendMessageCalls.some(c => c.message.type === 'show_overlay'));
});

test('navigate shows the overlay only after the page finishes loading', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'n1', type: 'navigate', params: { url: 'https://x.test' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(fakes.tabsSendMessageCalls.some(c => c.message.type === 'show_overlay'), false,
    'overlay must not be shown before the navigation completes — the old page (and its content script) is gone');

  fakes.fireUpdated(1, { status: 'complete' });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.ok(fakes.tabsSendMessageCalls.some(c => c.message.type === 'show_overlay'));
});

test('screenshot hides the overlay, waits for the reply, then captures and shows it again', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 's1', type: 'screenshot', params: {} }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(
    fakes.callOrder.filter(c => ['sendMessage:hide_overlay', 'captureVisibleTab', 'sendMessage:show_overlay'].includes(c)),
    ['sendMessage:hide_overlay', 'captureVisibleTab', 'sendMessage:show_overlay'],
  );
});

test('the first command on an ungrouped tab creates a Marshall tab group', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'g1', type: 'click', params: { selector: '#go' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(fakes.groupCalls, [{ tabIds: [1] }]);
  assert.equal(fakes.tabGroupsUpdateCalls.length, 1);
  assert.equal(fakes.tabGroupsUpdateCalls[0].props.title, 'Marshall');
  assert.equal(fakes.tabGroupsUpdateCalls[0].props.color, 'purple');
});

test('a second command on the same tab does not create a second group', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'g2', type: 'click', params: { selector: '#a' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));
  socket.emit('message', { data: JSON.stringify({ id: 'g3', type: 'click', params: { selector: '#b' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(fakes.groupCalls.length, 1, 'the tab is already grouped by the second command');
});

test('a tab already in some group (the user\'s own) is left alone', async () => {
  const fakes = installFakes();
  fakes.setActiveTabGroupId(42); // simulates a pre-existing, unrelated group
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'g4', type: 'click', params: { selector: '#a' } }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(fakes.groupCalls, []);
});

test('screenshot and navigate also mark the tab controlled (overlay + grouping)', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'g5', type: 'screenshot', params: {} }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(fakes.groupCalls.length, 1);
});

test('an unknown command type answers with ok:false instead of throwing past the handler', async () => {
  const fakes = installFakes();
  Object.assign(fakes.storage, { bridgeUrl: 'ws://127.0.0.1:1/bridge', token: 'tok' });
  await loadBackground();
  await new Promise(resolve => setTimeout(resolve, 10));

  const socket = fakes.created[0];
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ id: 'c5', type: 'not_a_real_command', params: {} }) });
  await new Promise(resolve => setTimeout(resolve, 10));

  const response = JSON.parse(socket.sent.at(-1)!);
  assert.equal(response.ok, false);
  assert.match(response.error, /unknown command/);
});
