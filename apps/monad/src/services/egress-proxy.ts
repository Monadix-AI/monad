// Local filtering HTTP proxy for confined children (sandbox net policy points HTTP(S)_PROXY here).
// A confined child can only reach this loopback port; every destination is gated by the egress
// allowlist before a single upstream byte flows, so the child's curl/pip/npm/git only reach allowed
// hosts. This is the egress enforcement point AND the only opening in an otherwise net:'none' jail.
//
// Two proxy modes:
//   - CONNECT host:port            → TLS tunnel (the https path: pip/npm/git/curl all use it)
//   - GET/POST http://host/path …  → plain-HTTP forward (request-target rewritten to origin-form)
//
// SSRF: the host is allowlist-checked, then on dial every resolved address is re-checked with
// isBlockedIp (a public name resolving to a private IP is refused — DNS-rebinding defence).

import type { Socket } from 'bun';

import { lookup } from 'node:dns/promises';

import { type EgressPolicy, isBlockedIp, isEgressAllowed } from '@/capabilities/tools';

const MAX_HEADER_BYTES = 64 * 1024; // a request head larger than this is hostile/broken
const CRLF2 = '\r\n\r\n';

export interface EgressProxy {
  readonly port: number;
  /** Value to set as HTTP_PROXY/HTTPS_PROXY in the confined child's env. */
  readonly url: string;
  stop(): void;
}

export interface EgressProxyOptions {
  policy: EgressPolicy;
  /** Override the allow decision (tests). Defaults to the egress allowlist over `policy`. */
  isAllowed?: (host: string) => boolean;
  /** Override upstream resolution check (tests). Defaults to DNS + isBlockedIp. */
  assertDialable?: (host: string) => Promise<void>;
  log?: (message: string) => void;
}

interface Conn {
  phase: 'header' | 'piping' | 'closed';
  chunks: string[]; // header bytes accumulated as latin1 so byte boundaries are preserved
  len: number;
  upstream: Socket<UpData> | null;
  pending: Buffer[]; // client bytes seen before the upstream is connected
}
interface UpData {
  client: Socket<Conn>;
}

function reply(socket: Socket<Conn>, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.end();
}

async function defaultAssertDialable(host: string): Promise<void> {
  // A bare IP literal was already screened by isEgressAllowed; this catches a name that resolves
  // into private space.
  const records = await lookup(host, { all: true });
  for (const { address } of records) {
    if (isBlockedIp(address)) throw new Error(`host ${host} resolves to a blocked address ${address}`);
  }
}

export function startEgressProxy(opts: EgressProxyOptions): EgressProxy {
  const isAllowed = opts.isAllowed ?? ((host: string) => isEgressAllowed(host, opts.policy));
  const assertDialable = opts.assertDialable ?? defaultAssertDialable;

  const server = Bun.listen<Conn>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { phase: 'header', chunks: [], len: 0, upstream: null, pending: [] };
      },
      data(socket, data) {
        const conn = socket.data;
        if (conn.phase === 'piping') {
          // Tunnel/forward established: relay client → upstream (buffer if mid-connect).
          if (conn.upstream) conn.upstream.write(data);
          else conn.pending.push(Buffer.from(data));
          return;
        }
        if (conn.phase === 'closed') return;

        conn.chunks.push(Buffer.from(data).toString('latin1'));
        conn.len += data.length;
        const head = conn.chunks.join('');
        const end = head.indexOf(CRLF2);
        if (end === -1) {
          if (conn.len > MAX_HEADER_BYTES) reply(socket, '431 Request Header Fields Too Large');
          return;
        }
        conn.phase = 'piping';
        const headerBlock = head.slice(0, end);
        const rest = Buffer.from(head.slice(end + CRLF2.length), 'latin1');
        void route(socket, headerBlock, rest, { isAllowed, assertDialable, log: opts.log });
      },
      close(socket) {
        socket.data.phase = 'closed';
        socket.data.upstream?.end();
      },
      error(socket) {
        socket.data.upstream?.end();
      }
    }
  });

  const port = server.port;
  return { port, url: `http://127.0.0.1:${port}`, stop: () => server.stop(true) };
}

async function route(
  client: Socket<Conn>,
  headerBlock: string,
  earlyBody: Buffer,
  deps: { isAllowed: (h: string) => boolean; assertDialable: (h: string) => Promise<void>; log?: (m: string) => void }
): Promise<void> {
  const nl = headerBlock.indexOf('\r\n');
  const firstLine = nl === -1 ? headerBlock : headerBlock.slice(0, nl);
  const parts = firstLine.split(' ');
  const method = parts[0];
  const target = parts[1];
  if (!method || !target) return reply(client, '400 Bad Request');

  const isConnect = method.toUpperCase() === 'CONNECT';
  let host: string;
  let port: number;
  let initialUpstream: Buffer;
  if (isConnect) {
    const authority = parseAuthority(target);
    if (!authority) return reply(client, '400 Bad Request');
    host = authority.host;
    port = authority.port;
    initialUpstream = earlyBody;
  } else {
    const abs = parseAbsolute(target);
    if (!abs) return reply(client, '400 Bad Request');
    host = abs.host;
    port = abs.port;
    // Rewrite the absolute request-target to origin-form before replaying upstream.
    const rewritten = headerBlock.replace(target, abs.path);
    initialUpstream = Buffer.concat([Buffer.from(`${rewritten}\r\n\r\n`, 'latin1'), earlyBody]);
  }

  if (!deps.isAllowed(host)) {
    deps.log?.(`egress denied: ${host}`);
    return reply(client, '403 Forbidden');
  }
  try {
    await deps.assertDialable(host);
  } catch {
    return reply(client, '403 Forbidden');
  }

  let upstream: Socket<UpData>;
  try {
    upstream = await Bun.connect<UpData>({
      hostname: host,
      port,
      socket: {
        data(_up, data) {
          client.write(data);
        },
        close() {
          client.end();
        },
        error() {
          client.end();
        }
      }
    });
  } catch {
    return reply(client, '502 Bad Gateway');
  }
  upstream.data = { client };

  client.data.upstream = upstream;
  if (isConnect) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (initialUpstream.length > 0) upstream.write(initialUpstream);
  // Flush any client bytes that arrived while we were connecting.
  for (const buf of client.data.pending) upstream.write(buf);
  client.data.pending = [];
}

function parseAuthority(target: string): { host: string; port: number } | null {
  const i = target.lastIndexOf(':');
  if (i === -1) return null;
  const host = stripBrackets(target.slice(0, i));
  const port = Number(target.slice(i + 1));
  return host && Number.isInteger(port) ? { host, port } : null;
}

function parseAbsolute(target: string): { host: string; port: number; path: string } | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null; // https arrives as CONNECT
  return {
    host: stripBrackets(url.hostname),
    port: url.port ? Number(url.port) : 80,
    path: `${url.pathname}${url.search}`
  };
}

function stripBrackets(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '');
}
