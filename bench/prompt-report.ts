// ── renders the two prompt-ranking runs into one HTML report ────────────────
//
// Parses the console output already captured to disk (runs/prompt-comparison-*/
// *.log) rather than re-running anything — the two sweeps already cost real
// GPU time, and the printed format is fully structured (this script is the
// only consumer, so the format and the parser can move together).

import { readFile, writeFile } from 'node:fs/promises';
import { PROMPT_CANDIDATES } from './prompt-candidates.js';

const RUN_DIR = process.argv[2] ?? 'runs/prompt-comparison-2026-08-27';
const MODEL_LOGS: Array<{ label: string; file: string }> = [
  { label: 'Ornith-1.5-35B-A3B (MoE)', file: `${RUN_DIR}/ornith.log` },
  { label: 'Qwen3.8-27B (dense, reasoning=medium)', file: `${RUN_DIR}/qwen38.log` },
];

interface LeaderboardRow { name: string; wins: number; points: number; avgRank: number }
interface TimingRow { name: string; passed: number; total: number; meanSecs: number; meanIn: number; meanOut: number; totalTok: number }
interface DetailRow { name: string; taskId: string; pass: boolean; secs: number; inTok: number; outTok: number }
interface CaseReasoning { taskId: string; ranking: string[]; reason: string }
interface ParsedRun {
  modelLine: string;
  leaderboard: LeaderboardRow[];
  timing: TimingRow[];
  detail: DetailRow[];
  cases: CaseReasoning[];
}

function parseLog(text: string): ParsedRun {
  const modelLine = /^Ranking .+ on (.+) over/.exec(text)?.[1] ?? 'unknown model';

  const leaderboard: LeaderboardRow[] = [];
  for (const m of text.matchAll(/^\d+\. (\S+)\s+wins: (\d+)\s+points: (\d+)\s+avg rank: ([\d.]+)/gm)) {
    leaderboard.push({ name: m[1], wins: Number(m[2]), points: Number(m[3]), avgRank: Number(m[4]) });
  }

  const timing: TimingRow[] = [];
  for (const m of text.matchAll(/^(\S+)\s+(\d+)\/(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+([\d,]+)$/gm)) {
    timing.push({
      name: m[1], passed: Number(m[2]), total: Number(m[3]), meanSecs: Number(m[4]),
      meanIn: Number(m[5]), meanOut: Number(m[6]), totalTok: Number(m[7].replace(/,/g, '')),
    });
  }

  const detail: DetailRow[] = [];
  for (const m of text.matchAll(/^ {2}(\S+)\s+(\S+)\s+(PASS|FAIL)\s+([\d.]+)s\s+in=(\d+)\s+out=(\d+)/gm)) {
    detail.push({ name: m[1], taskId: m[2], pass: m[3] === 'PASS', secs: Number(m[4]), inTok: Number(m[5]), outTok: Number(m[6]) });
  }

  const cases: CaseReasoning[] = [];
  const caseSection = text.split('=== Per-case reasoning ===')[1] ?? '';
  for (const m of caseSection.matchAll(/^\[(\S+)\] ranking: (.+)\n {2}(.+)$/gm)) {
    cases.push({ taskId: m[1], ranking: m[2].split(' > ').map(s => s.trim()), reason: m[3].trim() });
  }

  return { modelLine, leaderboard, timing, detail, cases };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const CANDIDATE_ORDER = Object.keys(PROMPT_CANDIDATES);
const seriesVar = (i: number) => `var(--series-${i + 1})`;

function legend() {
  return `<div class="legend">${CANDIDATE_ORDER.map((name, i) =>
    `<span class="legend-item"><span class="swatch" style="background:${seriesVar(i)}"></span>${esc(name)}</span>`).join('')}</div>`;
}

const W = 720, H = 260, PAD = { t: 16, r: 16, b: 34, l: 60 };
const PW = W - PAD.l - PAD.r, PH = H - PAD.t - PAD.b;

function axes(yTicks: { y: number; label: string }[], xLabel: string, yLabel: string) {
  const parts: string[] = [];
  for (const t of yTicks) {
    parts.push(`<line x1="${PAD.l}" y1="${t.y}" x2="${PAD.l + PW}" y2="${t.y}" stroke="var(--grid)" stroke-width="1"/>`);
    parts.push(`<text x="${PAD.l - 8}" y="${t.y + 4}" text-anchor="end" class="tick">${esc(t.label)}</text>`);
  }
  parts.push(`<line x1="${PAD.l}" y1="${PAD.t + PH}" x2="${PAD.l + PW}" y2="${PAD.t + PH}" stroke="var(--baseline)" stroke-width="1"/>`);
  parts.push(`<text x="${PAD.l + PW}" y="${H - 2}" text-anchor="end" class="axis-label">${esc(xLabel)}</text>`);
  parts.push(`<text x="0" y="${PAD.t - 4}" class="axis-label">${esc(yLabel)}</text>`);
  return parts.join('');
}

/** One grouped bar per model-run, bars ordered to match the legend/series colours. */
function groupedBarChart(runs: ParsedRun[], metric: (r: TimingRow) => number, { yLabel }: { yLabel: string }) {
  const values = runs.map(r => CANDIDATE_ORDER.map(name => metric(r.timing.find(t => t.name === name)!)));
  const maxVal = Math.max(...values.flat()) * 1.08;
  const yTicks = [0, 0.5, 1].map(f => ({ y: PAD.t + PH - f * PH, label: Math.round(f * maxVal).toLocaleString() }));
  const groupSlot = PW / runs.length;
  const groupW = groupSlot - 16;
  const barW = groupW / CANDIDATE_ORDER.length - 2;

  const bars = runs.flatMap((run, gi) => CANDIDATE_ORDER.map((name, ci) => {
    const val = values[gi][ci];
    const h = (val / maxVal) * PH;
    const x = PAD.l + gi * groupSlot + 8 + ci * (groupW / CANDIDATE_ORDER.length);
    const y = PAD.t + PH - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${seriesVar(ci)}"><title>${esc(`${name} · ${run.modelLine}: ${val.toLocaleString()}`)}</title></rect>`;
  })).join('');

  const xTicks = runs.map((run, gi) =>
    `<text x="${PAD.l + gi * groupSlot + groupSlot / 2}" y="${H - 2}" text-anchor="middle" class="tick">${esc(run.modelLine.split(' ')[0])}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)}">${axes(yTicks, '', yLabel)}${bars}${xTicks}</svg>`;
}

function leaderboardTable(run: ParsedRun) {
  const rows = run.leaderboard.map((r, i) => [String(i + 1), r.name, String(r.wins), String(r.points), r.avgRank.toFixed(2)]);
  return table(['#', 'candidate', 'wins', 'points', 'avg rank'], rows);
}

function timingTable(run: ParsedRun) {
  const rows = run.timing
    .sort((a, b) => CANDIDATE_ORDER.indexOf(a.name) - CANDIDATE_ORDER.indexOf(b.name))
    .map(r => [r.name, `${r.passed}/${r.total}`, r.meanSecs.toFixed(1), r.meanIn.toLocaleString(), r.meanOut.toLocaleString(), r.totalTok.toLocaleString()]);
  return table(['candidate', 'pass', 'mean secs', 'mean in', 'mean out', 'total tok'], rows);
}

function table(headers: string[], rows: string[][]) {
  return `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function caseSection(run: ParsedRun) {
  return run.cases.map(c => `
    <div class="case">
      <div class="case-task">${esc(c.taskId)}</div>
      <div class="case-ranking">${c.ranking.map((n, i) => `<span class="rank-chip" style="border-color:${seriesVar(CANDIDATE_ORDER.indexOf(n))}">${i + 1}. ${esc(n)}</span>`).join('')}</div>
      <div class="case-reason">${esc(c.reason)}</div>
    </div>`).join('');
}

const CSS = `
:root { color-scheme: light dark; }
body { margin:0; padding:32px; background:var(--page); color:var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height:1.5; }
.viz-root { --page:#f9f9f7; --surface-1:#fcfcfb; --text-primary:#0b0b0b; --text-secondary:#52514e;
  --muted:#898781; --grid:#e1e0d9; --baseline:#c3c2b7; --border:rgba(11,11,11,0.10);
  --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a; --series-4:#eda100; --series-5:#4a3aa7; }
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root { --page:#0d0d0d; --surface-1:#1a1a19;
    --text-primary:#ffffff; --text-secondary:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --baseline:#383835;
    --border:rgba(255,255,255,0.10); --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500; --series-5:#9085e9; }
}
:root[data-theme="dark"] .viz-root { --page:#0d0d0d; --surface-1:#1a1a19;
  --text-primary:#ffffff; --text-secondary:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --baseline:#383835;
  --border:rgba(255,255,255,0.10); --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500; --series-5:#9085e9; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:36px 0 10px; font-weight:600; }
h3 { font-size:14px; margin:20px 0 8px; font-weight:600; color:var(--text-secondary); }
.sub { color:var(--text-secondary); font-size:13px; margin:0 0 24px; max-width:900px; }
.two-col { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
@media (max-width:900px) { .two-col { grid-template-columns:1fr; } }
.prompts { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:8px; }
@media (max-width:900px) { .prompts { grid-template-columns:1fr; } }
.prompt-card { background:var(--surface-1); border:1px solid var(--border); border-radius:8px; overflow:hidden; }
.prompt-name { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em;
  padding:10px 14px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:8px; }
.prompt-name .swatch { width:10px; height:10px; border-radius:2px; flex:none; }
.prompt-text { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size:12px;
  white-space:pre-wrap; padding:14px; margin:0; color:var(--text-secondary); max-height:340px; overflow:auto; }
figure { background:var(--surface-1); border:1px solid var(--border); border-radius:8px; margin:0 0 16px; padding:12px 8px 4px; }
figcaption { font-size:12px; color:var(--text-secondary); padding:0 8px 8px; }
svg { width:100%; height:auto; display:block; }
.tick { font-size:10px; fill:var(--muted); } .axis-label { font-size:10px; fill:var(--muted); }
.legend { display:flex; gap:16px; flex-wrap:wrap; padding:0 8px 8px; font-size:12px; color:var(--text-secondary); }
.legend-item { display:inline-flex; align-items:center; gap:6px; }
.swatch { width:10px; height:10px; border-radius:2px; display:inline-block; }
table { border-collapse:collapse; font-size:13px; background:var(--surface-1); border:1px solid var(--border);
  border-radius:8px; overflow:hidden; font-variant-numeric:tabular-nums; width:100%; margin-bottom:16px; }
th,td { text-align:right; padding:6px 12px; border-bottom:1px solid var(--grid); }
th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align:left; }
th { font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
tbody tr:last-child td { border-bottom:none; }
.case { background:var(--surface-1); border:1px solid var(--border); border-radius:8px; padding:12px 14px; margin-bottom:10px; }
.case-task { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; color:var(--text-secondary); margin-bottom:6px; }
.case-ranking { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
.rank-chip { font-size:11px; border:1.5px solid; border-radius:12px; padding:2px 8px; color:var(--text-secondary); }
.case-reason { font-size:13px; color:var(--text-secondary); }
.note { background:var(--surface-1); border:1px solid var(--border); border-left:3px solid var(--series-2);
  border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px; }
`;

async function main() {
  const runs: ParsedRun[] = [];
  for (const { file } of MODEL_LOGS) {
    runs.push(parseLog(await readFile(file, 'utf8')));
  }

  const promptCards = CANDIDATE_ORDER.map((name, i) => `
    <div class="prompt-card">
      <div class="prompt-name"><span class="swatch" style="background:${seriesVar(i)}"></span>${esc(name)}</div>
      <pre class="prompt-text">${esc(PROMPT_CANDIDATES[name])}</pre>
    </div>`).join('');

  const modelSections = runs.map(run => `
    <h2>${esc(run.modelLine)}</h2>
    <div class="two-col">
      <div><h3>Judge leaderboard</h3>${leaderboardTable(run)}</div>
      <div><h3>Completion time &amp; tokens (mean per task)</h3>${timingTable(run)}</div>
    </div>
    <h3>Per-task judge reasoning</h3>
    ${caseSection(run)}
  `).join('\n');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prompt candidate comparison</title><style>${CSS}</style></head>
<body class="viz-root">
<h1>System-prompt candidates — ranked and measured</h1>
<p class="sub">Five candidate coder system prompts, ranked by an independent local judge (Tiel-Coder,
temperature 0) on four short deterministic tasks (bug-fix, feature-add, refactor, iterate), with
completion time and token counts measured directly from each run — not estimated. Run against two
different models to check whether a result generalises or is model-specific.</p>

<div class="note">No single candidate wins on both models — <code>bare</code> tops the Ornith
leaderboard and finishes 4th on Qwen3.8; <code>incremental</code> does the reverse. Absolute
timing/token figures are not comparable <em>across</em> the two model sections below (different
architectures — Ornith is a 3B-active MoE, Qwen3.8 is a dense 27B); only the relative comparison
between candidates within one model section is meaningful.</div>

<h2>The five candidates</h2>
<div class="prompts">${promptCards}</div>

<h2>Mean completion time by candidate</h2>
<figure>${legend()}${groupedBarChart(runs, r => r.meanSecs, { yLabel: 'seconds' })}
<figcaption>Mean wall-clock time per task, per candidate. Not comparable across the two model groups — only within each.</figcaption></figure>

<h2>Total tokens by candidate</h2>
<figure>${legend()}${groupedBarChart(runs, r => r.totalTok, { yLabel: 'tokens' })}
<figcaption>Total tokens (input + output) summed across all 4 tasks, per candidate.</figcaption></figure>

${modelSections}
</body></html>`;

  const outPath = `${RUN_DIR}/report.html`;
  await writeFile(outPath, html);
  console.log(`wrote ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
