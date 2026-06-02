// Imported ONLY behind the dev dead-branch; the release build's define + tree-shaking drops it.
// Never re-export from index.ts.

import type { CommandEvent, KvServer } from './server.ts';

export interface KvDebugServerOptions {
  /** TCP port (default: MONAD_KV_UI_PORT env, else 6480). */
  port?: number;
  /** Bind address (default 127.0.0.1 — loopback only). */
  host?: string;
}

export interface KvDebugServer {
  stop(): void;
  url: string;
  port: number;
}

interface WsData {
  unsubscribe: (() => void) | null;
}

export function startKvDebugServer(kv: KvServer, opts?: KvDebugServerOptions): KvDebugServer {
  const host = opts?.host ?? '127.0.0.1';
  const port = opts?.port ?? (Number(Bun.env.MONAD_KV_UI_PORT) || 6480);

  const json = (data: unknown): Response =>
    new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

  const server = Bun.serve<WsData>({
    hostname: host,
    port,
    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        if (srv.upgrade(req, { data: { unsubscribe: null } })) return undefined;
        return new Response('websocket upgrade failed', { status: 400 });
      }

      if (url.pathname === '/') {
        return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      if (url.pathname === '/api/dump') {
        return json(kv.store.inspect());
      }

      if (url.pathname === '/api/stream') {
        const name = url.searchParams.get('name');
        if (!name) return json({ error: 'missing name' });
        const count = Number(url.searchParams.get('count')) || 100;
        return json({ name, entries: kv.store.xrange(name, '-', '+', count) });
      }

      if (url.pathname === '/api/key') {
        const name = url.searchParams.get('name');
        if (!name) return json({ error: 'missing name' });
        const value = kv.store.get(name);
        return json({ name, value: value ? value.toString('utf8') : null, ttlMs: kv.store.pttl(name) });
      }

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.data.unsubscribe = kv.onCommand((event: CommandEvent) => {
          ws.send(JSON.stringify(event));
        });
      },
      close(ws) {
        ws.data.unsubscribe?.();
        ws.data.unsubscribe = null;
      },
      message() {
        // UI sends no messages; inbound frames are ignored.
      }
    }
  });

  const boundPort = server.port ?? port;
  return {
    stop: () => server.stop(true),
    url: `http://${host}:${boundPort}`,
    port: boundPort
  };
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>monad kv — debug</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #0e1116; color: #d7dde5; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #161b22; border-bottom: 1px solid #232a33; }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: #f85149; }
  header .dot.live { background: #3fb950; }
  header .spacer { flex: 1; }
  button { font: inherit; background: #21262d; color: #d7dde5; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  button:hover { background: #2d333b; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #232a33; height: calc(100vh - 45px); }
  section { background: #0e1116; overflow: auto; padding: 12px 16px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #768390; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #1b212a; vertical-align: top; word-break: break-all; }
  th { color: #768390; font-weight: 500; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: #161b22; }
  .muted { color: #59636e; }
  .pill { display: inline-block; padding: 0 6px; border-radius: 4px; background: #1f6feb22; color: #58a6ff; font-size: 11px; }
  #mon { white-space: pre-wrap; font-size: 12px; }
  #mon .row { padding: 1px 0; border-bottom: 1px solid #141a21; }
  #mon .ts { color: #59636e; }
  #mon .cmd { color: #58a6ff; }
  #mon .conn { color: #d29922; }
  .empty { color: #59636e; padding: 8px 0; }
</style>
</head>
<body>
<header>
  <span class="dot" id="wsdot"></span>
  <h1>monad kv — debug</h1>
  <span class="spacer"></span>
  <button id="refresh">Refresh data</button>
  <button id="pause">Pause monitor</button>
  <button id="clear">Clear</button>
</header>
<main>
  <section id="data">
    <h2>Data</h2>
    <div id="dataBody"><div class="empty">loading…</div></div>
  </section>
  <section id="monitor">
    <h2>Live monitor</h2>
    <div id="mon"></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ttl = (ms) => (ms === -1 ? '∞' : ms === -2 ? '—' : Math.round(ms / 1000) + 's');

async function loadData() {
  let d;
  try { d = await (await fetch('/api/dump')).json(); }
  catch { $('dataBody').innerHTML = '<div class="empty">failed to load</div>'; return; }

  let html = '';

  html += '<h2>Strings <span class="pill">' + d.strings.length + '</span></h2>';
  if (d.strings.length) {
    html += '<table><tr><th>key</th><th>ttl</th><th>size</th><th>preview</th></tr>';
    for (const s of d.strings)
      html += '<tr><td>' + esc(s.key) + '</td><td class="muted">' + ttl(s.ttlMs) + '</td><td class="muted">' + s.size + '</td><td>' + esc(s.preview) + '</td></tr>';
    html += '</table>';
  } else html += '<div class="empty">none</div>';

  html += '<h2>Streams <span class="pill">' + d.streams.length + '</span></h2>';
  if (d.streams.length) {
    html += '<table><tr><th>key</th><th>len</th><th>last id</th></tr>';
    for (const s of d.streams)
      html += '<tr class="clickable" data-stream="' + esc(s.key) + '"><td>' + esc(s.key) + '</td><td class="muted">' + s.length + '</td><td class="muted">' + esc(s.lastId) + '</td></tr>';
    html += '</table><div id="streamDetail"></div>';
  } else html += '<div class="empty">none</div>';

  html += '<h2>Pub/Sub channels <span class="pill">' + d.channels.length + '</span></h2>';
  if (d.channels.length) {
    html += '<table><tr><th>channel</th><th>subscribers</th></tr>';
    for (const c of d.channels)
      html += '<tr><td>' + esc(c.name) + '</td><td class="muted">' + c.subscribers + '</td></tr>';
    html += '</table>';
  } else html += '<div class="empty">none</div>';

  $('dataBody').innerHTML = html;
  for (const row of document.querySelectorAll('[data-stream]'))
    row.onclick = () => showStream(row.getAttribute('data-stream'));
}

async function showStream(name) {
  const detail = $('streamDetail');
  detail.innerHTML = '<div class="empty">loading ' + esc(name) + '…</div>';
  const d = await (await fetch('/api/stream?name=' + encodeURIComponent(name) + '&count=50')).json();
  let html = '<h2>' + esc(name) + ' entries <span class="pill">' + d.entries.length + '</span></h2><table><tr><th>id</th><th>fields</th></tr>';
  for (const e of d.entries) {
    const pairs = [];
    for (let i = 0; i < e.fields.length; i += 2) pairs.push(esc(e.fields[i]) + '=' + esc(e.fields[i + 1]));
    html += '<tr><td>' + esc(e.id) + '</td><td>' + pairs.join(' ') + '</td></tr>';
  }
  detail.innerHTML = html + '</table>';
}

let paused = false;
const mon = $('mon');
function connect() {
  const ws = new WebSocket('ws://' + location.host + '/ws');
  ws.onopen = () => $('wsdot').classList.add('live');
  ws.onclose = () => { $('wsdot').classList.remove('live'); setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    if (paused) return;
    const e = JSON.parse(ev.data);
    const t = new Date(e.ts).toISOString().slice(11, 23);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span class="ts">' + t + '</span> <span class="conn">#' + e.connId + '</span> <span class="cmd">' + esc(e.args[0] || '') + '</span> ' + esc(e.args.slice(1).join(' '));
    mon.appendChild(row);
    while (mon.childElementCount > 1000) mon.removeChild(mon.firstChild);
    mon.scrollTop = mon.scrollHeight;
  };
}

$('refresh').onclick = loadData;
$('clear').onclick = () => { mon.innerHTML = ''; };
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Resume monitor' : 'Pause monitor'; };

loadData();
connect();
setInterval(loadData, 3000);
</script>
</body>
</html>`;
