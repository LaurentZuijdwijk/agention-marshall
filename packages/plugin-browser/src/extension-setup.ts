/** Public installation guide: never include a pairing token in this page. */
export function extensionSetupPage(port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Install Marshall Browser Control</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.6; }
    body { max-width: 680px; margin: 48px auto; padding: 0 24px; }
    h1 { line-height: 1.2; }
    li { margin: 20px 0; }
    code { overflow-wrap: anywhere; }
    .download { display: inline-block; background: #2459cf; color: white; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>Install Marshall Browser Control</h1>
    <p>The browser plugin is running. Install its companion extension to let Marshall control browser tabs and take screenshots.</p>
    <p><a class="download" href="/extension.zip" download="marshall-browser-extension.zip">Download extension ZIP</a></p>
    <ol>
      <li><strong>Extract the ZIP</strong> into a folder you will keep, such as <code>Documents/Marshall Browser Control</code>. No source checkout or build is needed.</li>
      <li><strong>Open your browser's extensions page.</strong> Copy <code>chrome://extensions</code> into Chrome's address bar, or <code>edge://extensions</code> in Edge. Turn on <strong>Developer mode</strong>.</li>
      <li><strong>Choose Load unpacked</strong> and select the extracted folder containing <code>manifest.json</code>, not the ZIP file. Keep this folder after installation: the browser loads the extension from it.</li>
      <li><strong>Pin Marshall Browser Control</strong> from your browser's Extensions menu, then click its toolbar icon.</li>
      <li><strong>Pair with Marshall.</strong> Paste the pairing token printed in your Marshall terminal into the popup and click <strong>Save &amp; connect</strong>. For this server, the <strong>Advanced: bridge URL</strong> is <code>ws://127.0.0.1:${port}/bridge</code>. Check that the popup says <strong>connected</strong>.</li>
    </ol>
    <h2>Already installed?</h2>
    <p>You do not need to reinstall or pair again when re-enabling the plugin in Marshall. Open the extension popup to check its connection; if it is disabled, click <strong>Enable</strong>.</p>
    <h2>Troubleshooting</h2>
    <p>Keep Marshall running while downloading and connecting. If the browser cannot find the manifest, select the folder directly containing <code>manifest.json</code>. If it cannot connect, check the pairing token and bridge URL in the popup.</p>
    <p>For a managed plugin, a previously saved token is in your global Marshall config (<code>~/.config/marshall/config.json</code>, or under <code>$XDG_CONFIG_HOME/marshall</code>). For a standalone server, use the token from its terminal. Keep tokens private; never put them in project files or share them.</p>
    <p>Installation requires your approval in the browser; this page cannot silently install an extension.</p>
  </main>
</body>
</html>`;
}
