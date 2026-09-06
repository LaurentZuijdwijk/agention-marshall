# marshall-browser-extension

A Chrome extension (Manifest V3) that gives
[`@agentionai/marshall-plugin-browser`](../plugin-browser) a browser to
drive. It holds a WebSocket connection to that local server and carries out
whatever it relays — navigate, screenshot, click, type, read the page, read
its console — against your active tab.

Not published anywhere; you build and load it unpacked.

## Build

```bash
npm run build -w packages/browser-extension
```

Produces `dist/` — a loadable unpacked extension.

## Load it into Chrome

1. `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `packages/browser-extension/dist`
4. Click the extension's toolbar icon (pin it first if Chrome hid it behind
   the puzzle-piece menu) to open the popup
5. Paste the pairing token `marshall-plugin-browser` printed on startup,
   click **Save & connect**

The popup's status dot updates live. If the server restarts, its token
changes (unless it's CLI-managed via `/plugins add browser`, which persists
one) — re-paste it.

## The popup

Click the toolbar icon any time to see:

- **Status**: a coloured dot + text — connected, not paired, disconnected
  (retrying), disabled, or an error from the bridge itself.
- **Pairing token** (+ an "Advanced" fold-out for the bridge URL, defaulted
  to the standard local one — most people never need to touch it).
- **Disable/Enable**: pauses the connection without forgetting the token —
  flips a stored `enabled` flag that stops the automatic reconnect/keepalive
  from fighting you. Click again to reconnect.
- **Close tabs**: closes every tab currently in the "Marshall" tab group —
  a quick way to clean up after a session.

## How it's put together

- `background.ts` — the service worker. Holds the WebSocket connection and
  dispatches each relayed command to `chrome.tabs`/`chrome.scripting`
  against whatever tab is currently active. Reconnects on drop (unless
  disabled — see the popup); a `chrome.alarms` heartbeat keeps re-affirming
  the connection so Chrome's MV3 service-worker eviction doesn't silently
  drop it. Also marks each tab it touches — see "Visual indicators" below —
  and handles the popup's `close_marshall_tabs` message.
- `popup.ts`/`popup.html` — the toolbar popup described above, backed by
  `chrome.storage.local`.
- `overlay.ts` (isolated world) — the in-page pulsing border + badge,
  toggled by `show_overlay`/`hide_overlay` runtime messages from
  `background.ts`.
- `console-capture-main.ts` (runs in the page's **MAIN** world) +
  `console-capture-relay.ts` (isolated world) — a content-script pair that
  wraps the page's own `console.*` and buffers it for `browser_console_logs`.
  Two scripts because a MAIN-world script sees the page's real console but
  has no access to `chrome.*` APIs, and an isolated-world script has the
  opposite problem — the pair talks to each other over `window.postMessage`.
- `protocol.ts` — the shapes shared across the above, matching
  `plugin-browser`'s `bridge.ts` on the other end of the WebSocket.

## Visual indicators

So it's obvious when Marshall is driving a tab:

- **In-page**: a pulsing violet border around the viewport plus a small
  "🤖 Marshall is controlling this tab" badge (`overlay.ts`). Both are hidden
  automatically for the instant a screenshot is captured, so neither shows up
  in the image itself.
- **Tab strip**: the first time Marshall acts on a tab, it's added to a
  purple "Marshall" tab group (`chrome.tabGroups`) — visible even when that
  tab isn't the focused one, and even across a navigation within the same
  tab. A tab already in some other group (the user's own organisation) is
  left alone rather than moved. Tabs stay grouped once joined; there's no
  live ungroup on disable.

## Permissions

`tabs`, `tabGroups`, `scripting`, `storage`, `alarms`, and
`host_permissions: ["<all_urls>"]`. The broad host permission is what lets a
relayed command act on whatever tab is active without a fresh user gesture
each time — this is a tool for *you* to hand to your own coding agent, not
something meant for the Chrome Web Store's general audience.

## Development

```bash
npm run typecheck -w packages/browser-extension
npm run test -w packages/browser-extension   # background.ts's dispatch logic, against fake chrome/WebSocket globals
```

There's no way to load an unpacked extension into a real browser from this
repo's automated tests, so `background.ts` is covered by faking the
`chrome.*`/`WebSocket` globals it talks to rather than by a real Chrome
instance — verify end to end by actually loading it (above) before trusting
a change that touches it.
