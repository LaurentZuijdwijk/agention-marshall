// ── harness comparison: marshall vs pi vs opencode ──────────────────────────
//
// Reads every results.json under bench/runs/ and renders one self-contained
// HTML page comparing the three harnesses on the same task, model and
// check() verifier.
//
// Two things this deliberately does not do.
//
// It does not pool trials across code states. marshall's numbers moved several
// times in one day (the read gate came out, the shell guidance went in), so a
// mean over every marshall trial ever recorded would describe no version of the
// software. Each marshall config is therefore read from its LATEST run
// directory only, and the run id is printed beside it. `pi` and `opencode` are
// external CLIs that marshall's changes cannot affect, so their trials pool
// freely.
//
// It does not invent the cells that were never measured. A missing
// harness/model pair renders as an explicit "not run" rather than a zero or an
// interpolation, because the sparse grid is itself a finding about what the
// comparison does and does not yet support.
//
// Usage: node bench/harness-comparison.mjs [outfile]

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, 'runs');
const TASK = 'multi-file-migration';

/** Which harness a config name belongs to, and which model it ran on. */
function classify(config, modelFromHeader) {
  if (config.startsWith('pi-') || config === 'pi') return { harness: 'pi', model: modelFromHeader };
  if (config.startsWith('opencode')) return { harness: 'opencode', model: modelFromHeader };
  return { harness: 'marshall', model: modelFromHeader };
}

const MODEL_LABEL = {
  'openai/gpt-5.6-luna': 'GPT-5.6 Luna',
  'z-ai/glm-5.3-flash': 'GLM-5.3 Flash',
  'qwen/qwen3.8-flash': 'Qwen3.8 Flash',
};

function collect() {
  const runs = readdirSync(RUNS).filter(d => existsSync(join(RUNS, d, 'results.json'))).sort();
  /** key -> { runId, rows[] } ; latest run wins for marshall, pi/opencode accumulate */
  const byKey = new Map();

  for (const runId of runs) {
    const dir = join(RUNS, runId);
    let models = {};
    try {
      for (const c of JSON.parse(readFileSync(join(dir, 'header.json'), 'utf8')).configs ?? []) {
        if (c && typeof c === 'object') models[c.name] = c.model;
      }
    } catch { /* older runs have no header; those rows are skipped below */ }

    let results;
    try { results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')); } catch { continue; }

    for (const r of results) {
      if (r.task !== TASK) continue;
      const model = models[r.config];
      if (!model || !MODEL_LABEL[model]) continue;
      const { harness } = classify(r.config, model);
      const key = `${harness}|${model}|${r.config}`;
      const prev = byKey.get(key);
      // marshall: latest run only. external CLIs: pool every trial.
      if (harness === 'marshall' && prev && prev.runId !== runId) byKey.set(key, { runId, rows: [r] });
      else if (prev) prev.rows.push(r);
      else byKey.set(key, { runId, rows: [r] });
    }
  }
  return byKey;
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function summarise(byKey) {
  const out = [];
  for (const [key, { runId, rows }] of byKey) {
    const [harness, model, config] = key.split('|');
    const tokened = rows.filter(r => Number.isFinite(r.inputTokens) && r.inputTokens > 0);
    out.push({
      harness, model, config, runId,
      trials: rows.length,
      passed: rows.filter(r => r.pass).length,
      calls: mean(rows.map(r => r.toolCalls ?? 0)),
      seconds: median(rows.map(r => r.durationMs / 1000)),
      inTok: tokened.length ? mean(tokened.map(r => r.inputTokens)) : null,
      outTok: tokened.length ? mean(tokened.map(r => r.outputTokens)) : null,
    });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.harness.localeCompare(b.harness) || a.config.localeCompare(b.config));
}

const rows = summarise(collect());
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

// Best marshall config per model, plus every external row — that is the
// comparison the page leads with. Marshall's other configs stay in the table
// underneath, since "which marshall config" is the whole story of how it got
// there and dropping it would overstate the result.
const best = new Map();
for (const r of rows.filter(r => r.harness === 'marshall')) {
  const cur = best.get(r.model);
  if (!cur || r.passed / r.trials > cur.passed / cur.trials
    || (r.passed / r.trials === cur.passed / cur.trials && r.calls < cur.calls)) best.set(r.model, r);
}

const PALETTE = { marshall: ['#2a78d6', '#3987e5'], pi: ['#eb6834', '#d95926'], opencode: ['#1baf7a', '#199e70'] };
const HARNESSES = ['marshall', 'pi', 'opencode'];
const MODELS = Object.keys(MODEL_LABEL);

const headline = [];
for (const model of MODELS) {
  for (const h of HARNESSES) {
    const r = h === 'marshall' ? best.get(model) : rows.find(x => x.harness === h && x.model === model);
    headline.push({ model, harness: h, r: r ?? null });
  }
}

writeFileSync(process.argv[2] ?? join(HERE, 'harness-comparison.html'), render({ headline, rows }));
console.log(`wrote ${process.argv[2] ?? 'bench/harness-comparison.html'} — ${rows.length} config/model cells, ${rows.reduce((a, r) => a + r.trials, 0)} trials`);

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function render({ headline, rows }) {
  const maxCalls = Math.max(...headline.filter(d => d.r).map(d => d.r.calls));
  const maxSecs = Math.max(...headline.filter(d => d.r).map(d => d.r.seconds));

  const bars = (metric, max, fmt, unit) => MODELS.map(model => {
    const group = headline.filter(d => d.model === model);
    return `<div class="group">
      <div class="group-label">${esc(MODEL_LABEL[model])}</div>
      <div class="bars">
        ${group.map(({ harness, r }) => {
          if (!r) return `<div class="row"><span class="hname">${harness}</span><div class="track"><div class="notrun">not run</div></div></div>`;
          const v = r[metric];
          const pct = Math.max(1.5, (v / max) * 100);
          return `<div class="row" tabindex="0"
              data-tip="${esc(harness)} · ${esc(MODEL_LABEL[model])}\n${fmt(v)}${unit}\n${r.passed}/${r.trials} passed · ${r.trials} trial${r.trials === 1 ? '' : 's'}\nconfig: ${esc(r.config)}">
            <span class="hname">${harness}</span>
            <div class="track"><div class="bar h-${harness}" style="width:${pct}%"></div><span class="val">${fmt(v)}${unit}</span></div>
          </div>`;
        }).join('')}
      </div></div>`;
  }).join('');

  const tableRows = rows.map(r => `<tr>
    <td><span class="dot h-${r.harness}"></span>${esc(r.harness)}</td>
    <td>${esc(MODEL_LABEL[r.model])}</td>
    <td class="mono">${esc(r.config)}</td>
    <td class="num">${r.passed}/${r.trials}</td>
    <td class="num">${r.calls.toFixed(1)}</td>
    <td class="num">${r.seconds.toFixed(1)}</td>
    <td class="num">${r.inTok === null ? '<span class="na">n/a</span>' : Math.round(r.inTok).toLocaleString()}</td>
    <td class="num">${r.outTok === null ? '<span class="na">n/a</span>' : Math.round(r.outTok).toLocaleString()}</td>
    <td class="mono tiny">${esc(r.runId)}</td></tr>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Coding agent comparison — multi-file-migration</title>
<style>
:root{
  --surface:#fcfcfb; --plane:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,0.10);
  --marshall:#2a78d6; --pi:#eb6834; --opencode:#1baf7a;
}
@media (prefers-color-scheme:dark){:root{
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,0.10);
  --marshall:#3987e5; --pi:#d95926; --opencode:#199e70;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:40px 24px}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:24px;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--ink2);margin:0 0 28px;max-width:70ch}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px 24px;margin-bottom:22px}
h2{font-size:16px;margin:0 0 4px}
.hint{color:var(--muted);font-size:13px;margin:0 0 18px}
.legend{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 20px;font-size:13px;color:var(--ink2)}
.legend span{display:inline-flex;align-items:center;gap:7px}
.sw{width:11px;height:11px;border-radius:3px;display:inline-block}
.group{margin-bottom:20px}
.group:last-child{margin-bottom:0}
.group-label{font-size:12px;font-weight:600;color:var(--ink2);letter-spacing:.02em;margin-bottom:8px;
  padding-bottom:6px;border-bottom:1px solid var(--grid)}
.row{display:flex;align-items:center;gap:10px;margin-bottom:5px;outline:none;border-radius:4px}
.row:hover,.row:focus{background:color-mix(in srgb,var(--muted) 9%,transparent)}
.hname{width:74px;flex:none;font-size:12px;color:var(--muted);text-align:right}
.track{position:relative;flex:1;display:flex;align-items:center;gap:9px;height:22px}
.bar{height:13px;border-radius:0 4px 4px 0;box-shadow:0 0 0 2px var(--surface)}
.h-marshall{background:var(--marshall)} .h-pi{background:var(--pi)} .h-opencode{background:var(--opencode)}
.val{font-size:12.5px;color:var(--ink2);font-variant-numeric:tabular-nums}
.notrun{font-size:12px;color:var(--muted);font-style:italic}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--ink2);border-bottom:1px solid var(--axis);padding:7px 9px;font-size:12px}
td{padding:7px 9px;border-bottom:1px solid var(--grid);color:var(--ink2)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.tiny{color:var(--muted);font-size:10.5px}
.na{color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:7px}
#tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--ink);
  color:var(--surface);padding:8px 11px;border-radius:7px;font-size:12px;white-space:pre-line;z-index:9;max-width:280px}
.note{font-size:12.5px;color:var(--muted);margin-top:14px;padding-top:12px;border-top:1px solid var(--grid)}
</style></head><body data-palette="#2a78d6,#eb6834,#1baf7a"><div class="wrap">

<h1>Coding agents on the same task</h1>
<p class="sub">Three harnesses run the identical 28-file logging migration, from identical fixtures,
graded by the identical <code>check()</code> — 122 tests that must pass. Lower is better on both
charts. Each bar is the mean (calls) or median (time) of that cell's trials.</p>

<div class="card">
  <h2>Tool calls per run</h2>
  <p class="hint">How many round trips to the model it took. The metric the harness controls most directly.</p>
  <div class="legend">
    ${HARNESSES.map(h => `<span><i class="sw h-${h}"></i>${h}</span>`).join('')}
  </div>
  ${bars('calls', maxCalls, v => v.toFixed(1), '')}
</div>

<div class="card">
  <h2>Wall-clock time</h2>
  <p class="hint">Median seconds per run. Dominated by how fast and how verbosely the model generates.</p>
  <div class="legend">
    ${HARNESSES.map(h => `<span><i class="sw h-${h}"></i>${h}</span>`).join('')}
  </div>
  ${bars('seconds', maxSecs, v => v.toFixed(0), 's')}
</div>

<div class="card">
  <h2>Every measured cell</h2>
  <p class="hint">All marshall configurations, not just the best one — the spread between them is
  most of what this exercise found.</p>
  <table>
    <thead><tr><th>harness</th><th>model</th><th>config</th><th class="num">pass</th>
      <th class="num">calls</th><th class="num">sec</th><th class="num">in tok</th>
      <th class="num">out tok</th><th>run</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <p class="note"><strong>Reading this honestly.</strong> marshall cells come from their latest run
  only — its behaviour changed several times in one day, so pooling every trial would describe no
  version that ever existed. <code>pi</code> and <code>opencode</code> are external CLIs unaffected
  by those changes, so their trials pool. <code>opencode</code> reports no token usage through its
  CLI, hence <span class="na">n/a</span>. Blank cells were never run rather than zero. Trial counts
  are small (1–5); treat gaps under ~20% as noise.</p>
</div>

</div><div id="tip"></div><script>
const tip=document.getElementById('tip');
for(const el of document.querySelectorAll('[data-tip]')){
  const show=e=>{tip.textContent=el.dataset.tip;tip.style.opacity=1;
    const r=el.getBoundingClientRect();
    tip.style.left=Math.min(window.innerWidth-296,(e.clientX??r.left)+14)+'px';
    tip.style.top=((e.clientY??r.top)+16)+'px';};
  el.addEventListener('mousemove',show);
  el.addEventListener('focus',show);
  el.addEventListener('mouseleave',()=>tip.style.opacity=0);
  el.addEventListener('blur',()=>tip.style.opacity=0);
}
</script></body></html>`;
}
