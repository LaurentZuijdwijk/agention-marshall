#!/usr/bin/env node
// ── renders a run directory into a single self-contained HTML report ────────
//
//   node report.mjs runs/2026-08-26T09-38-58-361Z
//
// Reads the CSVs that run.ts archived and draws the four things the run was
// commissioned to answer — success, duration, tokens in/out, and the shape of
// the generation and prefill distributions — plus the context series, which is
// the reason the whole exercise exists.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SURFACE = { light: '#fcfcfb', dark: '#1a1a19' };

function parseCsv(text) {
  const [head, ...rows] = text.trim().split('\n');
  const cols = head.split(',');
  return rows.filter(Boolean).map(line => {
    // Values here are numbers, booleans and ISO stamps — no embedded commas —
    // so a plain split is sufficient and keeps this dependency-free.
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

const num = v => (v === '' || v === undefined ? undefined : Number(v));

/**
 * Equal-width bins.
 *
 * The bin count follows the sample count (Rice-ish, capped): a fixed 20 bins
 * over six samples draws six lonely spikes separated by empty space, which
 * reads as structure that isn't there.
 */
function histogram(values, maxBins = 20) {
  if (!values.length) return [];
  const binCount = Math.max(1, Math.min(maxBins, Math.ceil(Math.sqrt(values.length))));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return [{ lo, hi, count: values.length }];
  const width = (hi - lo) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({ lo: lo + i * width, hi: lo + (i + 1) * width, count: 0 }));
  for (const v of values) {
    const idx = Math.min(binCount - 1, Math.floor((v - lo) / width));
    bins[idx].count++;
  }
  return bins;
}

function quantile(sorted, p) {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => (n === undefined ? '—' : n >= 10000 ? n.toLocaleString('en-US') : String(Math.round(n * 10) / 10));

const W = 720, H = 272, PAD = { t: 28, r: 88, b: 34, l: 58 };
const PW = W - PAD.l - PAD.r, PH = H - PAD.t - PAD.b;

/** Slot n of the categorical palette. Assigned in fixed order, never cycled. */
const seriesVar = i => `var(--series-${i + 1})`;

function axes(xTicks, yTicks, xLabel, yLabel) {
  const parts = [];
  for (const t of yTicks) {
    parts.push(`<line x1="${PAD.l}" y1="${t.y}" x2="${PAD.l + PW}" y2="${t.y}" stroke="var(--grid)" stroke-width="1"/>`);
    parts.push(`<text x="${PAD.l - 8}" y="${t.y + 4}" text-anchor="end" class="tick">${esc(t.label)}</text>`);
  }
  for (const t of xTicks) {
    parts.push(`<text x="${t.x}" y="${PAD.t + PH + 18}" text-anchor="middle" class="tick">${esc(t.label)}</text>`);
  }
  parts.push(`<line x1="${PAD.l}" y1="${PAD.t + PH}" x2="${PAD.l + PW}" y2="${PAD.t + PH}" stroke="var(--baseline)" stroke-width="1"/>`);
  parts.push(`<text x="${PAD.l + PW}" y="${H - 2}" text-anchor="end" class="axis-label">${esc(xLabel)}</text>`);
  parts.push(`<text x="0" y="11" class="axis-label">${esc(yLabel)}</text>`);
  return parts.join('');
}

/**
 * A legend is mandatory once there are two series — identity must never rest on
 * colour alone. With only one, the title already names it and a legend box is
 * just chrome.
 */
function legend(series) {
  if (series.length < 2) return '';
  return `<div class="legend">${series.map((s, i) =>
    `<span class="legend-item"><span class="swatch" style="background:${seriesVar(i)}"></span>${esc(s.label)}</span>`).join('')}</div>`;
}

/** One set of bin edges shared by every series, so the bars are comparable. */
function sharedBins(seriesValues, maxBins = 16) {
  const all = seriesValues.flat();
  if (!all.length) return [];
  const lo = Math.min(...all), hi = Math.max(...all);
  const n = Math.max(1, Math.min(maxBins, Math.ceil(Math.sqrt(all.length / seriesValues.length))));
  if (lo === hi) return [{ lo, hi, counts: seriesValues.map(v => v.length) }];
  const width = (hi - lo) / n;
  const bins = Array.from({ length: n }, (_, i) => ({
    lo: lo + i * width, hi: lo + (i + 1) * width, counts: seriesValues.map(() => 0),
  }));
  seriesValues.forEach((values, si) => {
    for (const v of values) bins[Math.min(n - 1, Math.floor((v - lo) / width))].counts[si]++;
  });
  return bins;
}

/**
 * Grouped bars, not overlaid translucent ones: two series drawn on top of each
 * other with alpha produce a third colour that belongs to neither of them and
 * reads as a category of its own.
 */
function groupedBarChart(bins, series, { xLabel, yLabel, fmtEdge = fmt }) {
  if (!bins.length) return '<p class="empty">No data.</p>';
  const maxCount = Math.max(...bins.flatMap(b => b.counts));
  const yTicks = [0, 0.5, 1].map(f => ({ y: PAD.t + PH - f * PH, label: fmt(Math.round(f * maxCount)) }));
  const slot = PW / bins.length;
  const groupW = Math.max(1, slot - 3);
  const bw = Math.max(1, groupW / series.length - 2);
  const bars = bins.flatMap((b, i) => b.counts.map((count, si) => {
    const h = maxCount ? (count / maxCount) * PH : 0;
    const x = PAD.l + i * slot + si * (groupW / series.length);
    const y = PAD.t + PH - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${seriesVar(si)}"><title>${esc(`${series[si].label} · ${fmtEdge(b.lo)}–${fmtEdge(b.hi)}: ${count}`)}</title></rect>`;
  })).join('');
  const xTicks = [0, Math.floor(bins.length / 2), bins.length - 1].map(i => ({
    x: PAD.l + i * slot + groupW / 2, label: fmtEdge(bins[i].lo),
  }));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} by ${esc(xLabel)}">${axes(xTicks, yTicks, xLabel, yLabel)}${bars}</svg>`;
}

function multiLineChart(series, { xLabel, yLabel, reference }) {
  const maxX = Math.max(...series.map(s => s.points.length)) - 1;
  const maxY = Math.max(...series.flatMap(s => s.points), reference?.value ?? 0) * 1.08;
  if (!(maxX > 0) || !(maxY > 0)) return '<p class="empty">Not enough points.</p>';
  const sx = i => PAD.l + (i / maxX) * PW;
  const sy = v => PAD.t + PH - (v / maxY) * PH;
  const yTicks = [0, 0.5, 1].map(f => ({ y: PAD.t + PH - f * PH, label: fmt(Math.round(f * maxY)) }));
  const xTicks = [0, Math.floor(maxX / 2), maxX].map(i => ({ x: sx(i), label: String(i + 1) }));
  const ref = reference
    ? `<line x1="${PAD.l}" y1="${sy(reference.value)}" x2="${PAD.l + PW}" y2="${sy(reference.value)}" stroke="var(--muted)" stroke-width="2" stroke-dasharray="6 4"/>`
      + `<text x="${PAD.l + PW}" y="${sy(reference.value) - 6}" text-anchor="end" class="ref-label">${esc(reference.label)}</text>`
    : '';
  const drawn = series.map((s, si) => {
    const d = s.points.map((y, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');
    const dots = s.points.map((y, i) =>
      `<circle cx="${sx(i).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="4" fill="${seriesVar(si)}" stroke="var(--surface-1)" stroke-width="2"><title>${esc(`${s.label} · request ${i + 1}: ${fmt(y)}`)}</title></circle>`).join('');
    // Direct label at the series end, so identity survives without the legend.
    const last = s.points.length - 1;
    const tag = `<text x="${sx(last) + 6}" y="${sy(s.points[last]) + 4}" class="series-label" fill="${seriesVar(si)}">${esc(s.label)}</text>`;
    return `<path d="${d}" fill="none" stroke="${seriesVar(si)}" stroke-width="2"/>${dots}${tag}`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} by ${esc(xLabel)}">${axes(xTicks, yTicks, xLabel, yLabel)}${ref}${drawn}</svg>`;
}

function multiScatter(series, { xLabel, yLabel }) {
  const pts = series.flatMap(s => s.points);
  if (!pts.length) return '<p class="empty">No data.</p>';
  const maxX = Math.max(...pts.map(p => p.x)) * 1.05;
  const maxY = Math.max(...pts.map(p => p.y)) * 1.1;
  const sx = v => PAD.l + (v / maxX) * PW;
  const sy = v => PAD.t + PH - (v / maxY) * PH;
  const yTicks = [0, 0.5, 1].map(f => ({ y: PAD.t + PH - f * PH, label: fmt(Math.round(f * maxY)) }));
  const xTicks = [0, 0.5, 1].map(f => ({ x: PAD.l + f * PW, label: fmt(Math.round(f * maxX)) }));
  const dots = series.map((s, si) => s.points.map(p =>
    `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" fill="${seriesVar(si)}" stroke="var(--surface-1)" stroke-width="2"><title>${esc(`${s.label} · ${fmt(p.x)} tok context, ${fmt(p.y)} tok/s`)}</title></circle>`).join('')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} by ${esc(xLabel)}">${axes(xTicks, yTicks, xLabel, yLabel)}${dots}</svg>`;
}

function statTile(label, value, note) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${note ? `<div class="tile-note">${esc(note)}</div>` : ''}</div>`;
}

function table(headers, rows) {
  return `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

const CSS = `
:root { color-scheme: light dark; }
body { margin:0; padding:32px; background:var(--page); color:var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height:1.5; }
.viz-root { --page:#f9f9f7; --surface-1:${SURFACE.light}; --text-primary:#0b0b0b; --text-secondary:#52514e;
  --muted:#898781; --grid:#e1e0d9; --baseline:#c3c2b7; --border:rgba(11,11,11,0.10);
  --series-1:#2a78d6; --series-2:#eb6834; --good:#0ca30c; --critical:#d03b3b; }
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root { --page:#0d0d0d; --surface-1:${SURFACE.dark};
    --text-primary:#ffffff; --text-secondary:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --baseline:#383835;
    --border:rgba(255,255,255,0.10); --series-1:#3987e5; --series-2:#d95926; }
}
:root[data-theme="dark"] .viz-root { --page:#0d0d0d; --surface-1:${SURFACE.dark};
  --text-primary:#ffffff; --text-secondary:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --baseline:#383835;
  --border:rgba(255,255,255,0.10); --series-1:#3987e5; --series-2:#d95926; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:15px; margin:32px 0 8px; font-weight:600; }
.sub { color:var(--text-secondary); font-size:13px; margin:0 0 24px; }
.tiles { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:8px; }
.tile { background:var(--surface-1); border:1px solid var(--border); border-radius:8px; padding:12px 16px; min-width:130px; }
.tile-label { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.tile-value { font-size:22px; font-weight:600; margin-top:2px; }
.tile-note { font-size:11px; color:var(--text-secondary); margin-top:2px; }
figure { background:var(--surface-1); border:1px solid var(--border); border-radius:8px; margin:0 0 16px; padding:12px 8px 4px; }
figcaption { font-size:12px; color:var(--text-secondary); padding:0 8px 8px; }
svg { width:100%; height:auto; display:block; }
.tick { font-size:10px; fill:var(--muted); } .axis-label { font-size:10px; fill:var(--muted); }
.ref-label { font-size:10px; fill:var(--series-2); }
table { border-collapse:collapse; font-size:13px; background:var(--surface-1); border:1px solid var(--border);
  border-radius:8px; overflow:hidden; font-variant-numeric:tabular-nums; }
th,td { text-align:right; padding:6px 12px; border-bottom:1px solid var(--grid); }
th:first-child, td:first-child { text-align:left; }
th { font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
tbody tr:last-child td { border-bottom:none; }
.empty { color:var(--muted); font-size:13px; padding:24px 12px; }
.legend { display:flex; gap:16px; flex-wrap:wrap; padding:0 8px 8px; font-size:12px; color:var(--text-secondary); }
.legend-item { display:inline-flex; align-items:center; gap:6px; }
.swatch { width:10px; height:10px; border-radius:2px; display:inline-block; }
.series-label { font-size:10px; font-weight:600; }
.tilerow { margin-bottom:4px; }
.tilerow-label { font-size:12px; color:var(--text-secondary); margin:12px 0 6px; font-weight:600; }
.verdict { background:var(--surface-1); border:1px solid var(--border); border-left:3px solid var(--series-1);
  border-radius:8px; padding:12px 16px; font-size:14px; margin-bottom:8px; }
`;

function medianTrial(trials) {
  const sorted = [...trials].sort((a, b) => (a.res?.durationMs ?? 0) - (b.res?.durationMs ?? 0));
  return sorted[Math.floor(sorted.length / 2)];
}

function statRow(label, trials) {
  const secs = trials.map(t => (t.res?.durationMs ?? 0) / 1000);
  const ctx = trials.map(t => Math.max(...t.reqs.map(r => num(r.contextTokens))));
  const sent = trials.map(t => t.reqs.reduce((a, r) => a + num(r.contextTokens), 0));
  const recv = trials.map(t => t.reqs.reduce((a, r) => a + num(r.generatedTokens), 0));
  const rec = trials.map((t, i) => t.reqs.reduce((a, r) => a + num(r.recomputedTokens), 0) / sent[i] * 100);
  const tg = trials.flatMap(t => t.tg);
  const passes = trials.filter(t => t.res?.pass).length;
  const med = xs => quantile([...xs].sort((a, b) => a - b), 0.5);
  return `<div class="tilerow-label">${esc(label)}</div><div class="tiles tilerow">
    ${statTile('Passed', `${passes}/${trials.length}`, `${trials.length} trial(s)`)}
    ${statTile('Duration', `${med(secs).toFixed(0)}s`, 'median')}
    ${statTile('Requests', String(med(trials.map(t => t.reqs.length))), 'median')}
    ${statTile('Tokens sent', fmt(med(sent)), `peak context ${fmt(med(ctx))}`)}
    ${statTile('Tokens received', fmt(med(recv)), 'median')}
    ${statTile('Prompt recomputed', `${med(rec).toFixed(1)}%`, 'median')}
    ${statTile('TG median', `${med(tg).toFixed(1)} tok/s`, `${tg.length} samples`)}
  </div>`;
}

async function main() {
  const runDirs = process.argv.slice(2);
  if (!runDirs.length) { console.error('usage: node report.mjs <runDir> [runDir...]'); process.exit(1); }

  // Keyed by task, then by config, so two harnesses that ran the same task in
  // different sweeps still land on the same axes.
  const byTask = new Map();
  let header;
  for (const runDir of runDirs) {
    const h = JSON.parse(await readFile(join(runDir, 'header.json'), 'utf8'));
    header ??= h;
    const results = JSON.parse(await readFile(join(runDir, 'results.json'), 'utf8'));
    const dirs = (await readdir(runDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
    for (const name of dirs.sort()) {
      const reqs = parseCsv(await readFile(join(runDir, name, 'requests.csv'), 'utf8')).filter(r => r.complete === 'true');
      if (!reqs.length) continue;
      const tg = parseCsv(await readFile(join(runDir, name, 'tg-samples.csv'), 'utf8')).map(r => Number(r.tps));
      const res = results.find(r => `${r.config}__${r.task}__trial${r.trial}` === name);
      const [config, task] = [res?.config ?? name.split('__')[0], res?.task ?? name.split('__')[1]];
      if (!byTask.has(task)) byTask.set(task, new Map());
      const byConfig = byTask.get(task);
      if (!byConfig.has(config)) byConfig.set(config, []);
      byConfig.get(config).push({ reqs, tg, res });
    }
  }

  const sections = [];
  for (const [task, byConfig] of [...byTask.entries()].sort()) {
    const configs = [...byConfig.keys()].sort();
    const series = configs.map(c => ({ label: c, trials: byConfig.get(c) }));

    const ctxSeries = series.map(s => ({
      label: s.label,
      points: medianTrial(s.trials).reqs.map(r => num(r.contextTokens)),
    }));
    const tgValues = series.map(s => s.trials.flatMap(t => t.tg));
    const recValues = series.map(s => s.trials.flatMap(t => t.reqs.map(r => num(r.recomputedTokens))));
    const scatterSeries = series.map(s => ({
      label: s.label,
      points: s.trials.flatMap(t => t.reqs.filter(r => r.evalTps).map(r => ({ x: num(r.contextTokens), y: num(r.evalTps) }))),
    }));
    const legendHtml = legend(series);

    const rows = series.map(s => {
      const trials = s.trials;
      const sent = trials.map(t => t.reqs.reduce((a, r) => a + num(r.contextTokens), 0));
      const med = xs => quantile([...xs].sort((a, b) => a - b), 0.5);
      return [
        s.label,
        `${trials.filter(t => t.res?.pass).length}/${trials.length}`,
        med(trials.map(t => (t.res?.durationMs ?? 0) / 1000)).toFixed(0),
        String(med(trials.map(t => t.reqs.length))),
        fmt(med(sent)),
        fmt(med(trials.map(t => Math.max(...t.reqs.map(r => num(r.contextTokens)))))),
        `${med(trials.map((t, i) => t.reqs.reduce((a, r) => a + num(r.recomputedTokens), 0) / sent[i] * 100)).toFixed(1)}%`,
        fmt(med(trials.map(t => t.reqs.reduce((a, r) => a + num(r.generatedTokens), 0)))),
        med([...s.trials.flatMap(t => t.tg)]).toFixed(1),
      ];
    });

    sections.push(`
<h2>${esc(task)}</h2>
${series.map(s => statRow(s.label, s.trials)).join('')}

<h3>Head to head</h3>
${table(['harness', 'passed', 'secs', 'reqs', 'sent', 'peak ctx', 'recomp', 'received', 'tg'], rows)}

<figure>${legendHtml}${multiLineChart(ctxSeries, { xLabel: 'request', yLabel: 'context (tokens)' })}
<figcaption>Prompt size per request, median-duration trial of each harness. Peaks are a fraction of the ${fmt(262144)}-token window; nothing was truncated in any trial.</figcaption></figure>

<figure>${legendHtml}${groupedBarChart(sharedBins(tgValues), series, { xLabel: 'tokens/sec', yLabel: 'samples' })}
<figcaption>Generation rate, all trials pooled. Sampled every ~3s of generation (<code>tg_3s</code>); responses shorter than one interval contribute their whole-request rate instead.</figcaption></figure>

<figure>${legendHtml}${groupedBarChart(sharedBins(recValues), series, { xLabel: 'tokens recomputed', yLabel: 'requests' })}
<figcaption>Prompt tokens the server actually had to compute per request — the rest came from the KV cache. Bars to the left mean a stable prefix.</figcaption></figure>

<figure>${legendHtml}${multiScatter(scatterSeries, { xLabel: 'context (tokens)', yLabel: 'generation (tok/s)' })}
<figcaption>Generation rate against context size, all requests of all trials. The downward slope is what context growth actually costs.</figcaption></figure>
`);
  }

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bench comparison</title><style>${CSS}</style></head>
<body class="viz-root"><h1>Bench comparison — ${esc(header?.instrumentedModel ?? '')}</h1>
<p class="sub">host ${esc(header?.host ?? '')} · window 262,144 tokens${header?.gitSha ? ` · ${esc(header.gitSha.slice(0, 8))}` : ''}<br>
Every figure is measured from llama-server's own slot logs, so both harnesses are counted by the same instrument rather than by their own self-reporting.</p>
${sections.join('\n') || '<p class="empty">No instrumented runs found.</p>'}
</body></html>`;

  const out = join(runDirs[0], 'report.html');
  await writeFile(out, html);
  console.log(`wrote ${out}`);
}

main().catch(err => { console.error(err); process.exit(1); });
