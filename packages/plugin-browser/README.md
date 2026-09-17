# @agentionai/marshall-plugin-browser

A local MCP server that gives the Marshall coding agent browser control and
screenshots — navigate, click, type, read a page, read its console, and see
what's on screen. It doesn't drive a browser itself; it's the server half of
a pair with [`marshall-browser-extension`](../browser-extension), a Chrome
extension that does the actual driving.

```
Chrome extension  <—WebSocket (loopback, token-paired)—>  this server  <—MCP over HTTP—>  Marshall
```

## Run it

### The easy way: let Marshall manage it

Inside the `marshall` CLI:

```
/plugins add browser
```

This spawns the server for you (reusing one already running at the default
port, if there is one), health-checks it, registers it as an MCP server, and
persists a pairing token in your global config — so it comes back up
automatically on future launches too, with no re-pairing needed. The first
time, it prints the token and a link to a local guided setup page at
`http://127.0.0.1:8712/setup`. Open it for a **Download extension ZIP** button
and step-by-step Chrome/Edge installation instructions; no checkout or build
is required. You can also [download from the website](https://marshall.agention.ai/docs.html#browser-extension)
before starting Marshall. The website ZIP tracks the latest site deployment;
the local ZIP matches your installed plugin. Keep Marshall running while pairing. Extract the ZIP into a
permanent folder, then use **Load unpacked** on your browser's extensions page
to select the folder containing `manifest.json`. Pin the extension, open its
popup, paste the pairing token, and click **Save & connect**. `/plugins disable browser` stops it and unregisters
it. `/plugins` (or `/plugins list`) on its own lists what's configured.

### The manual way

```bash
npx @agentionai/marshall-plugin-browser
```

It prints an MCP endpoint and a one-time pairing token:

```
marshall-plugin-browser is running.

  MCP endpoint:  http://127.0.0.1:8712/mcp
  Pairing token: <random>
```

1. Add the endpoint to your project's `.marshall/config.json`:

   ```json
   { "mcpServers": [{ "name": "browser", "url": "http://127.0.0.1:8712/mcp" }] }
   ```

2. Open [the guided setup page](http://127.0.0.1:8712/setup) while the
   server is running (use your server port if changed), download the ZIP,
   and extract it into a permanent folder. Load
   the extracted folder into Chrome (`chrome://extensions` → Developer mode
   → Load unpacked), click its
   toolbar icon, and paste the pairing token into the popup.

Restarting a manually-run server generates a new token; re-paste it into the
extension. (The managed path above avoids this by persisting the token.)

### Either way

The server binds to `127.0.0.1` only. The token is what stops a page from
pairing with the bridge itself — a bare open loopback port would otherwise be
reachable from any tab's own `fetch`/`WebSocket`.

## Tools

| Tool | What it does |
|---|---|
| `browser_navigate` | Navigate the active tab to a URL |
| `browser_screenshot` | Capture the active tab's visible viewport |
| `browser_click` | Click the first element matching a CSS selector |
| `browser_type` | Type into the first input/textarea matching a CSS selector |
| `browser_press_key` | Press a key (Enter, Escape, Tab, arrows, a character), with optional modifiers |
| `browser_read_page` | Read the active tab's content as `markdown` (default), `text`, or `html` |
| `browser_console_logs` | Read recent `console.*` output, uncaught errors and failed resource loads from the active tab |

`browser_read_page`'s `markdown` mode keeps structure — headings, lists,
links with their `href` — at a fraction of `html`'s cost, so the model can
act on a link without a second `html` read just to find its destination.
`text` is cheaper still when structure and links don't matter; `html` is the
full page markup for when real tags/attributes/classes are needed.

Every call goes through Marshall's normal MCP approval gate — nothing here
bypasses it. `browser_screenshot`'s image reaches the model as real vision
input (not a wall of base64 text), via Marshall's generic MCP image-result
support (`ToolConfig.attachImages` in `@agentionai/marshall-tools`) — any MCP
server returning image content blocks gets this, not just this one.

Deliberately not in v1: multi-tab management, full-page screenshot
stitching, an arbitrary-JS `eval` tool, and accessibility-tree reading.

The ZIP is included in the published plugin package and contains no pairing
token. You can download it again while the server is running.

## Development

```bash
npm run build -w packages/plugin-browser   # compile
npm run test -w packages/plugin-browser    # unit + a real MCP-client end-to-end test
npm run start -w packages/plugin-browser   # run from source
```
