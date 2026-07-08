import type { LocRow } from './types.ts';

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeHtml(htmlPath: string, rows: LocRow[]) {
  await mkdir(dirname(htmlPath), { recursive: true });
  await Bun.write(htmlPath, renderHtml(rows));
}

function renderHtml(rows: LocRow[]): string {
  const data = JSON.stringify(rows);
  const actualRows = rows.filter((row) => row.type === 'actual');
  const latest = rows.at(-1);
  const firstActual = actualRows[0];
  const latestActual = actualRows.at(-1);
  const growth =
    firstActual && latestActual && firstActual.lines > 0
      ? Math.round(((latestActual.lines - firstActual.lines) / firstActual.lines) * 100)
      : 0;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Monad LOC Daily Report</title>
  <style>
    :root { color-scheme: dark; --bg: #0b0f14; --panel: #111821; --panel-2: #17212d; --text: #edf4ff; --muted: #93a4b8; --line: #263445; --accent: #74e0c0; --accent-2: #8ab4ff; --warn: #f8c46c; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 15% 0%, #18314b 0, transparent 32rem), linear-gradient(135deg, #081018 0%, #0b0f14 52%, #10151d 100%); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1180px, calc(100vw - 40px)); margin: 0 auto; padding: 48px 0; }
    header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 32px; align-items: end; margin-bottom: 30px; }
    h1 { margin: 0; font-size: clamp(36px, 6vw, 78px); line-height: .92; letter-spacing: 0; max-width: 720px; }
    .lede { margin: 18px 0 0; color: var(--muted); font-size: 16px; line-height: 1.7; max-width: 680px; }
    .stamp { color: var(--muted); text-align: right; font-size: 13px; line-height: 1.7; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
    .metric, .chart, .table-wrap { border: 1px solid color-mix(in srgb, var(--line), transparent 20%); background: linear-gradient(180deg, color-mix(in srgb, var(--panel), transparent 2%), color-mix(in srgb, var(--panel-2), transparent 18%)); border-radius: 8px; box-shadow: 0 20px 70px rgba(0,0,0,.28); }
    .metric { padding: 18px; min-height: 128px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 16px; font-size: clamp(26px, 4vw, 44px); line-height: 1; font-weight: 760; }
    .sub { margin-top: 10px; color: var(--muted); font-size: 13px; }
    .chart { padding: 20px; margin-bottom: 16px; overflow: hidden; }
    .chart-head { display: flex; justify-content: space-between; gap: 20px; align-items: center; margin-bottom: 8px; }
    h2 { margin: 0; font-size: 18px; }
    .legend { display: flex; gap: 14px; color: var(--muted); font-size: 12px; }
    .legend span::before { content: ""; display: inline-block; width: 9px; height: 9px; border-radius: 99px; margin-right: 6px; background: var(--accent); }
    svg { width: 100%; height: auto; display: block; }
    .axis { stroke: #2b3949; stroke-width: 1; }
    .tick { stroke: #223041; stroke-width: 1; }
    .axis-text { fill: #93a4b8; font-size: 12px; }
    .axis-title { fill: #c5d5e8; font-size: 12px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
    .area { fill: url(#area); opacity: .85; }
    .line { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    .estimate { fill: var(--warn); opacity: .95; }
    .actual { fill: var(--accent); }
    .table-wrap { overflow: hidden; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; background: rgba(255,255,255,.03); }
    td:nth-child(2), td:nth-child(3) { font-variant-numeric: tabular-nums; }
    tr:last-child td { border-bottom: 0; }
    .pill { display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border-radius: 999px; background: rgba(116,224,192,.12); color: var(--accent); border: 1px solid rgba(116,224,192,.28); }
    @media (max-width: 860px) { main { width: min(100vw - 28px, 680px); padding: 28px 0; } header { grid-template-columns: 1fr; } .stamp { text-align: left; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .table-wrap { overflow-x: auto; } }
    @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 42px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Monad LOC Daily Report</h1>
        <p class="lede">Daily TypeScript line settlement at local midnight. Historical rows are rebuilt from real git snapshots; dates before the first available snapshot are fitted from the earliest real trend.</p>
      </div>
      <div class="stamp">Generated from <code>scripts/loc-daily.ts</code><br>Latest row ${latest?.date ?? 'n/a'}</div>
    </header>
    <section class="grid">
      <div class="metric"><div class="label">Latest lines</div><div class="value">${formatNumber(latest?.lines ?? 0)}</div><div class="sub">${latest?.type ?? 'n/a'} row</div></div>
      <div class="metric"><div class="label">Latest files</div><div class="value">${formatNumber(latest?.files ?? 0)}</div><div class="sub">TS/TSX files counted</div></div>
      <div class="metric"><div class="label">Actual growth</div><div class="value">${growth}%</div><div class="sub">${firstActual?.date ?? 'n/a'} to ${latestActual?.date ?? 'n/a'}</div></div>
      <div class="metric"><div class="label">Rows</div><div class="value">${formatNumber(rows.length)}</div><div class="sub">${formatNumber(actualRows.length)} actual snapshots</div></div>
    </section>
    <section class="chart">
      <div class="chart-head"><h2>Lines by day</h2><div class="legend"><span>actual</span><span>estimated</span></div></div>
      <svg id="chart" viewBox="0 0 1120 430" role="img" aria-label="Daily LOC chart"></svg>
    </section>
    <section class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Lines</th><th>Files</th><th>Type</th><th>Note</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </section>
  </main>
  <script>
    const rows = ${data};
    const fmt = new Intl.NumberFormat();
    const svg = document.getElementById('chart');
    const width = 1120, height = 430, pad = { left: 82, right: 28, top: 24, bottom: 62 };
    const max = Math.max(...rows.map((row) => row.lines), 1);
    const min = Math.min(...rows.map((row) => row.lines), 0);
    const span = Math.max(1, max - min);
    const x = (i) => pad.left + (i / Math.max(1, rows.length - 1)) * (width - pad.left - pad.right);
    const y = (value) => pad.top + (1 - (value - min) / span) * (height - pad.top - pad.bottom);
    const points = rows.map((row, i) => [x(i), y(row.lines)]);
    const line = points.map(([px, py], i) => \`\${i === 0 ? 'M' : 'L'}\${px.toFixed(1)},\${py.toFixed(1)}\`).join(' ');
    const area = \`\${line} L\${x(rows.length - 1).toFixed(1)},\${height - pad.bottom} L\${pad.left},\${height - pad.bottom} Z\`;
    const xTickIndexes = Array.from(new Set([0, Math.round((rows.length - 1) * .25), Math.round((rows.length - 1) * .5), Math.round((rows.length - 1) * .75), rows.length - 1])).filter((i) => rows[i]);
    const yTicks = Array.from({ length: 4 }, (_, i) => Math.round(min + (span * i) / 3));
    svg.innerHTML = \`
      <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#74e0c0" stop-opacity=".35"/><stop offset="100%" stop-color="#74e0c0" stop-opacity="0"/></linearGradient></defs>
      \${yTicks.map((tick) => \`<line class="tick" x1="\${pad.left}" y1="\${y(tick).toFixed(1)}" x2="\${width - pad.right}" y2="\${y(tick).toFixed(1)}"></line><text class="axis-text" x="\${pad.left - 12}" y="\${y(tick).toFixed(1)}" text-anchor="end" dominant-baseline="middle">\${fmt.format(tick)}</text>\`).join('')}
      \${xTickIndexes.map((i) => \`<line class="tick" x1="\${x(i).toFixed(1)}" y1="\${height - pad.bottom}" x2="\${x(i).toFixed(1)}" y2="\${height - pad.bottom + 6}"></line><text class="axis-text" x="\${x(i).toFixed(1)}" y="\${height - pad.bottom + 24}" text-anchor="middle">\${rows[i].date.slice(5)}</text>\`).join('')}
      <line class="axis" x1="\${pad.left}" y1="\${height - pad.bottom}" x2="\${width - pad.right}" y2="\${height - pad.bottom}"></line>
      <line class="axis" x1="\${pad.left}" y1="\${pad.top}" x2="\${pad.left}" y2="\${height - pad.bottom}"></line>
      <path class="area" d="\${area}"></path>
      <path class="line" d="\${line}"></path>
      \${rows.map((row, i) => \`<circle class="\${row.type}" cx="\${x(i).toFixed(1)}" cy="\${y(row.lines).toFixed(1)}" r="\${row.type === 'actual' ? 4.5 : 3.5}"><title>\${row.date}: \${fmt.format(row.lines)} lines</title></circle>\`).join('')}
      <text class="axis-title" x="\${(pad.left + width - pad.right) / 2}" y="\${height - 10}" text-anchor="middle">Date</text>
      <text class="axis-title" x="18" y="\${(pad.top + height - pad.bottom) / 2}" text-anchor="middle" transform="rotate(-90 18 \${(pad.top + height - pad.bottom) / 2})">Lines of code</text>
    \`;
    document.getElementById('rows').innerHTML = rows.toReversed().map((row) => \`
      <tr><td>\${row.date}</td><td>\${fmt.format(row.lines)}</td><td>\${row.files == null ? '' : fmt.format(row.files)}</td><td><span class="pill \${row.type}">\${row.type}</span></td><td>\${row.note}</td></tr>
    \`).join('');
  </script>
</body>
</html>
`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
