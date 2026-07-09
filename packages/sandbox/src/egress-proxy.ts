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

import type { Socket as NodeSocket } from 'node:net';
import type { Socket } from 'bun';
import type { MitmCA } from './mitm/ca.ts';

import { lookup } from 'node:dns/promises';

import { type EgressPolicy, isEgressAllowed } from './egress-policy.ts';
import { type FilterRequest, type RewriteBody, type RewriteRequest, terminateAndForward } from './mitm/terminate.ts';
import { isBlockedIp } from './security.ts';
import { feedSocks5, initSocks5Data, type Socks5Data, type Socks5Deps } from './socks5.ts';

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
  /**
   * Opt-in TLS termination. When set, an ALLOWED CONNECT is decrypted with a per-host leaf minted
   * from this CA, parsed as HTTP/1.1, and re-issued upstream over a real TLS connection (upstream
   * verification stays on). When absent, HTTPS stays an opaque byte tunnel (today's behavior).
   */
  mitm?: MitmCA;
  /** Per-request gate applied to each decrypted request under `mitm`. Default: allow. Ignored without `mitm`. */
  filterRequest?: FilterRequest;
  /**
   * Rewrite the outbound request-head under `mitm`, keyed by the upstream host — the credential-
   * sentinel substitution point (sentinel→real for a matching host, sentinel left intact otherwise).
   * Runs on the proxy→server leg only. Ignored without `mitm`.
   */
  rewriteRequest?: RewriteRequest;
  /** Body-substitution hook (sentinel→real in the request body); paired with rewriteRequest. */
  rewriteBody?: RewriteBody;
  /**
   * Extra CA(s) trusted on the proxy's OUTBOUND (proxy→server) leg under `mitm`. A TEST SEAM ONLY —
   * NODE_EXTRA_CA_CERTS is read at process start so a suite testing against a self-signed upstream
   * can't set it from inside the test. It NEVER disables verification; unset → system roots.
   */
  upstreamCA?: string | Buffer | Array<string | Buffer>;
  log?: (message: string) => void;
}

interface Conn {
  // 'peek' is the muxed initial state: the first byte decides SOCKS5 vs HTTP. Once dispatched to
  // HTTP the phase advances to 'header'; a SOCKS5 connection carries its own state in `socks`.
  phase: 'peek' | 'socks5' | 'header' | 'piping' | 'closed';
  chunks: string[]; // header bytes accumulated as latin1 so byte boundaries are preserved
  len: number;
  upstream: Socket<UpData> | null;
  // When TLS termination is active, client bytes flow to this Node socket (bridged to the inner
  // terminating server) instead of a Bun upstream socket.
  loop: NodeSocket | null;
  pending: Buffer[]; // client bytes seen before the upstream is connected
  // Set only when this connection was routed to the SOCKS5 handler (first byte 0x05).
  socks: Socks5Data | null;
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

  const socksDeps: Socks5Deps = { isAllowed, assertDialable, log: opts.log };

  const server = Bun.listen<Conn>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { phase: 'peek', chunks: [], len: 0, upstream: null, loop: null, pending: [], socks: null };
      },
      data(socket, data) {
        const conn = socket.data;
        // Mux: the first byte selects the protocol. 0x05 = SOCKS5, 0x04 = SOCKS4 (rejected), any
        // other byte = HTTP (all HTTP methods / PRI / TLS start well above 0x05). The peeked byte is
        // NOT consumed — it's fed into whichever handler owns the connection, so no bytes are lost.
        if (conn.phase === 'peek') {
          const first = data[0];
          if (first === undefined) return; // empty chunk; wait for real bytes
          if (first === 0x05) {
            conn.phase = 'socks5';
            conn.socks = initSocks5Data();
            feedSocks5(socket, conn.socks, data, socksDeps);
            return;
          }
          if (first === 0x04) {
            // SOCKS4 is unsupported. Reply a SOCKS4 request-rejected (VN=0x00, CD=0x5b, 6 zero bytes)
            // and close cleanly rather than mis-parsing it as HTTP.
            socket.write(new Uint8Array([0x00, 0x5b, 0, 0, 0, 0, 0, 0]));
            conn.phase = 'closed';
            socket.end();
            return;
          }
          // HTTP: fall through to the existing header state machine, feeding it this first chunk.
          conn.phase = 'header';
          // continue below into the HTTP path
        }
        if (conn.phase === 'socks5') {
          if (conn.socks) feedSocks5(socket, conn.socks, data, socksDeps);
          return;
        }
        if (conn.phase === 'piping') {
          // Tunnel/forward established: relay client → upstream (buffer if mid-connect).
          if (conn.loop) conn.loop.write(data);
          else if (conn.upstream) conn.upstream.write(data);
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
        void route(socket, headerBlock, rest, {
          isAllowed,
          assertDialable,
          mitm: opts.mitm,
          filterRequest: opts.filterRequest,
          rewriteRequest: opts.rewriteRequest,
          rewriteBody: opts.rewriteBody,
          upstreamCA: opts.upstreamCA,
          log: opts.log
        });
      },
      close(socket) {
        socket.data.phase = 'closed';
        socket.data.upstream?.end();
        socket.data.loop?.destroy();
        if (socket.data.socks) {
          socket.data.socks.phase = 'closed';
          socket.data.socks.upstream?.end();
        }
      },
      error(socket) {
        socket.data.upstream?.end();
        socket.data.loop?.destroy();
        if (socket.data.socks) {
          socket.data.socks.phase = 'closed';
          socket.data.socks.upstream?.end();
        }
      }
    }
  });

  const port = server.port;
  return { port, url: `http://127.0.0.1:${port}`, stop: () => server.stop(true) };
}

interface RouteDeps {
  isAllowed: (h: string) => boolean;
  assertDialable: (h: string) => Promise<void>;
  mitm?: MitmCA;
  filterRequest?: FilterRequest;
  rewriteRequest?: RewriteRequest;
  rewriteBody?: RewriteBody;
  upstreamCA?: string | Buffer | Array<string | Buffer>;
  log?: (m: string) => void;
}

async function route(client: Socket<Conn>, headerBlock: string, earlyBody: Buffer, deps: RouteDeps): Promise<void> {
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

  // TLS-terminating path: an allowed CONNECT is decrypted, inspected, and re-issued upstream over a
  // fresh TLS connection with real cert validation. The allow + dialable checks above still gate it.
  if (isConnect && deps.mitm) {
    terminateAndForward(
      deps.mitm,
      deps.filterRequest,
      { hostname: host, port, upstreamCA: deps.upstreamCA },
      ({ loop, close }) => {
        // Inner terminating server → Bun client (decrypted-then-re-encrypted TLS bytes back out).
        loop.on('data', (chunk: Buffer) => client.write(chunk));
        loop.once('close', () => {
          client.data.loop = null;
          client.end();
          close();
        });
        client.data.loop = loop;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // The client's ClientHello bytes may have arrived with the CONNECT line (earlyBody) or
        // been buffered while the inner server was standing up; replay both into the tunnel.
        if (initialUpstream.length > 0) loop.write(initialUpstream);
        for (const buf of client.data.pending) loop.write(buf);
        client.data.pending = [];
      },
      () => reply(client, '502 Bad Gateway'),
      deps.rewriteRequest,
      deps.rewriteBody
    );
    return;
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
