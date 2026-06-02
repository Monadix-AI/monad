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
import { connect as netConnect } from 'node:net';

import {
  ProtectedResponseBudget,
  type ProtectedResponseFailure,
  type ResponseRedactions
} from './credential-redaction-stream.ts';
import { SentinelRegistry } from './credential-sentinel.ts';
import { type EgressPolicy, isEgressAllowed, normalizeHost } from './egress-policy.ts';
import { createMitmCA, disposeMitmCA, disposeMitmCASync } from './mitm/ca.ts';
import {
  type FilterRequest,
  interceptHttpAndForward,
  type RewriteBody,
  type RewriteRequest,
  type TerminateHandle,
  terminateAndForward
} from './mitm/terminate.ts';
import { caTrustEnv } from './mitm/trust-env.ts';
import { isBlockedIp } from './security.ts';
import { feedSocks5, initSocks5Data, type Socks5Data, type Socks5Deps } from './socks5.ts';

const MAX_HEADER_BYTES = 64 * 1024; // a request head larger than this is hostile/broken
const CRLF2 = '\r\n\r\n';
const DEFAULT_DIAL_TIMEOUT_MS = 10_000;
const MAX_DIAL_TIMEOUT_MS = 60_000;

type AssertDialable = (host: string, signal?: AbortSignal) => Promise<void>;

export interface RawConnectOptions {
  hostname: string;
  port: number;
  onData(data: Buffer): void;
  onClose(): void;
  onError(): void;
}

export interface RawConnectAttempt {
  readonly connected: Promise<void>;
  write(data: Uint8Array | string): void;
  end(): void;
  cancel(): void;
}

export type RawConnect = (options: RawConnectOptions) => RawConnectAttempt;

export interface EgressProxy {
  readonly port: number;
  /** Value to set as HTTP_PROXY/HTTPS_PROXY in the confined child's env. */
  readonly url: string;
  stop(): void;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  policy: EgressPolicy;
  /** Override the allow decision (tests). Defaults to the egress allowlist over `policy`. */
  isAllowed?: (host: string) => boolean;
  /** Override upstream resolution check (tests). Defaults to DNS + isBlockedIp. */
  assertDialable?: AssertDialable;
  dialTimeoutMs?: number;
  connectRaw?: RawConnect;
  connectTimeoutMs?: number;
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
  responseRedactions?: ResponseRedactions;
  onProtectedResponseFailure?: ProtectedResponseFailure;
  protectedResponseBudget?: ProtectedResponseBudget;
  disableSocks?: boolean;
  onProtectedTransportFailure?: (code: 'protected_transport_unsupported') => void;
  /**
   * Extra CA(s) trusted on the proxy's OUTBOUND (proxy→server) leg under `mitm`. A TEST SEAM ONLY —
   * NODE_EXTRA_CA_CERTS is read at process start so a suite testing against a self-signed upstream
   * can't set it from inside the test. It NEVER disables verification; unset → system roots.
   */
  upstreamCA?: string | Buffer | Array<string | Buffer>;
  log?: (message: string) => void;
}

export interface ProtectedCredential {
  environmentVariable: string;
  secret: string;
  allowedHosts: readonly string[];
}

export interface ProtectedExecutionProxy {
  readonly childEnv: Readonly<Record<string, string>>;
  readonly proxyEnv: Readonly<Record<string, string>>;
  readonly port: number;
  close(): Promise<void>;
}

export interface ProtectedExecutionProxyOptions {
  log?: (message: string) => void;
  caFactory?: () => MitmCA;
  registryFactory?: () => SentinelRegistry;
  assertDialable?: AssertDialable;
  dialTimeoutMs?: number;
}

interface Conn {
  // 'peek' is the muxed initial state: the first byte decides SOCKS5 vs HTTP. Once dispatched to
  // HTTP the phase advances to 'header'; a SOCKS5 connection carries its own state in `socks`.
  phase: 'peek' | 'socks5' | 'header' | 'piping' | 'closed';
  chunks: string[]; // header bytes accumulated as latin1 so byte boundaries are preserved
  len: number;
  upstream: RawConnectAttempt | null;
  // When TLS termination is active, client bytes flow to this Node socket (bridged to the inner
  // terminating server) instead of a Bun upstream socket.
  loop: NodeSocket | null;
  terminate: TerminateHandle | null;
  pending: Buffer[]; // client bytes seen before the upstream is connected
  // Set only when this connection was routed to the SOCKS5 handler (first byte 0x05).
  socks: Socks5Data | null;
}

function reply(socket: Socket<Conn>, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.end();
}

async function defaultAssertDialable(host: string, _signal?: AbortSignal): Promise<void> {
  // A bare IP literal was already screened by isEgressAllowed; this catches a name that resolves
  // into private space.
  const records = await lookup(host, { all: true });
  for (const { address } of records) {
    if (isBlockedIp(address)) throw new Error(`host ${host} resolves to a blocked address ${address}`);
  }
}

function normalizeDialTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return DEFAULT_DIAL_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_DIAL_TIMEOUT_MS);
}

async function assertDialableBounded(
  host: string,
  assertDialable: AssertDialable,
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('egress_dialability_timeout')), timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(() => assertDialable(host, signal)), timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function defaultConnectRaw(options: RawConnectOptions): RawConnectAttempt {
  const socket = netConnect({ host: options.hostname, port: options.port });
  let established = false;
  let cancelled = false;
  const connected = new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      socket.off('error', onConnectError);
      established = true;
      resolve();
    };
    const onConnectError = (): void => {
      socket.off('connect', onConnect);
      reject(new Error('egress_raw_connect_failed'));
    };
    socket.once('connect', onConnect);
    socket.once('error', onConnectError);
    socket.once('close', () => {
      if (!established) reject(new Error('egress_raw_connect_closed'));
    });
  });
  socket.on('data', options.onData);
  socket.on('close', () => {
    if (established) options.onClose();
  });
  socket.on('error', () => {
    if (established) options.onError();
  });

  return {
    connected,
    write(data) {
      if (!cancelled) socket.write(data);
    },
    end() {
      if (cancelled) return;
      if (established) socket.end();
      else {
        cancelled = true;
        socket.destroy();
      }
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      socket.destroy();
    }
  };
}

function waitForRawConnect(attempt: RawConnectAttempt, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      cancel();
      cancelRawAttempt(attempt);
      reject(new Error('egress_raw_connect_timeout'));
    }, timeoutMs);
    const onAbort = (): void => {
      cancel();
      cancelRawAttempt(attempt);
      reject(new Error('egress_raw_connect_cancelled'));
    };
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void attempt.connected.then(
      () => {
        if (settled) return;
        cancel();
        resolve();
      },
      () => {
        if (settled) return;
        cancel();
        reject(new Error('egress_raw_connect_failed'));
      }
    );
  });
}

function cancelRawAttempt(attempt: RawConnectAttempt): void {
  try {
    attempt.cancel();
  } catch {}
}

export function startEgressProxy(opts: EgressProxyOptions): EgressProxy {
  const isAllowed = opts.isAllowed ?? ((host: string) => isEgressAllowed(host, opts.policy));
  const assertDialable = opts.assertDialable ?? defaultAssertDialable;
  const dialTimeoutMs = normalizeDialTimeout(opts.dialTimeoutMs);
  const connectRaw = opts.connectRaw ?? defaultConnectRaw;
  const connectTimeoutMs = normalizeDialTimeout(opts.connectTimeoutMs);

  const socksDeps: Socks5Deps = { isAllowed, assertDialable, log: opts.log };
  const protectedResponseBudget = opts.responseRedactions
    ? (opts.protectedResponseBudget ?? new ProtectedResponseBudget())
    : undefined;
  const activeHandles = new Set<TerminateHandle>();
  const activeRoutes = new Set<Promise<void>>();
  const routeAbort = new AbortController();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const trackHandle = (handle: TerminateHandle): void => {
    activeHandles.add(handle);
    void handle.closed.finally(() => activeHandles.delete(handle));
    if (closing) handle.close();
  };
  const startRoute = (
    socket: Socket<Conn>,
    headerBlock: string,
    rest: Buffer,
    deps: Omit<RouteDeps, 'signal' | 'dialTimeoutMs'>
  ): void => {
    if (closing) {
      socket.data.phase = 'closed';
      socket.end();
      return;
    }
    const task = Promise.resolve()
      .then(() =>
        route(socket, headerBlock, rest, {
          ...deps,
          signal: routeAbort.signal,
          dialTimeoutMs
        })
      )
      .catch(() => {
        if (!closing) reply(socket, '502 Bad Gateway');
      });
    activeRoutes.add(task);
    void task.then(
      () => activeRoutes.delete(task),
      () => activeRoutes.delete(task)
    );
  };

  const server = Bun.listen<Conn>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = {
          phase: 'peek',
          chunks: [],
          len: 0,
          upstream: null,
          loop: null,
          terminate: null,
          pending: [],
          socks: null
        };
      },
      data(socket, data) {
        const conn = socket.data;
        if (closing) {
          conn.phase = 'closed';
          socket.end();
          return;
        }
        // Mux: the first byte selects the protocol. 0x05 = SOCKS5, 0x04 = SOCKS4 (rejected), any
        // other byte = HTTP (all HTTP methods / PRI / TLS start well above 0x05). The peeked byte is
        // NOT consumed — it's fed into whichever handler owns the connection, so no bytes are lost.
        if (conn.phase === 'peek') {
          const first = data[0];
          if (first === undefined) return; // empty chunk; wait for real bytes
          if (first === 0x05) {
            if (opts.disableSocks) {
              opts.onProtectedTransportFailure?.('protected_transport_unsupported');
              socket.write(new Uint8Array([0x05, 0xff]));
              conn.phase = 'closed';
              socket.end();
              return;
            }
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
        startRoute(socket, headerBlock, rest, {
          isAllowed,
          assertDialable,
          connectRaw,
          connectTimeoutMs,
          mitm: opts.mitm,
          filterRequest: opts.filterRequest,
          rewriteRequest: opts.rewriteRequest,
          rewriteBody: opts.rewriteBody,
          responseRedactions: opts.responseRedactions,
          onProtectedResponseFailure: opts.onProtectedResponseFailure,
          protectedResponseBudget,
          upstreamCA: opts.upstreamCA,
          log: opts.log,
          trackHandle
        });
      },
      close(socket) {
        socket.data.phase = 'closed';
        socket.data.upstream?.end();
        socket.data.terminate?.close();
        if (socket.data.socks) {
          socket.data.socks.phase = 'closed';
          socket.data.socks.upstream?.end();
        }
      },
      error(socket) {
        socket.data.upstream?.end();
        socket.data.terminate?.close();
        if (socket.data.socks) {
          socket.data.socks.phase = 'closed';
          socket.data.socks.upstream?.end();
        }
      }
    }
  });

  const port = server.port;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    routeAbort.abort();
    closePromise = (async () => {
      protectedResponseBudget?.close();
      const stopped = server.stop(true);
      for (const handle of activeHandles) handle.close();
      await stopped;
      while (activeRoutes.size > 0 || activeHandles.size > 0) {
        const routes = [...activeRoutes];
        const handles = [...activeHandles];
        for (const handle of handles) handle.close();
        await Promise.allSettled([...routes, ...handles.map((handle) => handle.closed)]);
      }
    })();
    return closePromise;
  };
  return { port, url: `http://127.0.0.1:${port}`, stop: () => void close(), close };
}

export function startProtectedExecutionProxy(
  credentials: readonly ProtectedCredential[],
  options: ProtectedExecutionProxyOptions = {}
): ProtectedExecutionProxy {
  const registry = (options.registryFactory ?? (() => new SentinelRegistry()))();
  const environmentVariables = new Set<string>();
  const allowedHosts = new Set<string>();

  for (const credential of credentials) {
    if (environmentVariables.has(credential.environmentVariable)) {
      throw new Error('protected_execution_duplicate_environment_variable');
    }
    environmentVariables.add(credential.environmentVariable);
    registry.register(
      credential.environmentVariable,
      credential.secret,
      credential.allowedHosts.map((host) => normalizeHost(host))
    );
    for (const host of credential.allowedHosts) allowedHosts.add(normalizeHost(host));
  }

  let ca: MitmCA | undefined;
  let proxy: EgressProxy | undefined;
  let childEnv: Readonly<Record<string, string>>;
  let proxyEnv: Readonly<Record<string, string>>;
  const protectedResponseBudget = new ProtectedResponseBudget();
  try {
    ca = (options.caFactory ?? createMitmCA)();
    proxy = startEgressProxy({
      policy: { allowedDomains: [] },
      isAllowed: (host) => allowedHosts.has(normalizeHost(host)),
      assertDialable: options.assertDialable,
      dialTimeoutMs: options.dialTimeoutMs,
      mitm: ca,
      rewriteRequest: (host, block) => registry.substitute(host, block),
      rewriteBody: (host, body) => registry.substitute(host, body),
      responseRedactions: () => registry.redactionsForResponse(),
      onProtectedResponseFailure: (code) => options.log?.(code),
      protectedResponseBudget,
      disableSocks: true,
      onProtectedTransportFailure: (code) => options.log?.(code)
    });
    childEnv = Object.freeze(registry.childEnv());
    proxyEnv = Object.freeze({
      HTTP_PROXY: proxy.url,
      HTTPS_PROXY: proxy.url,
      http_proxy: proxy.url,
      https_proxy: proxy.url,
      ALL_PROXY: '',
      all_proxy: '',
      NO_PROXY: '',
      no_proxy: '',
      ...caTrustEnv(ca.caCertPath)
    });
    options.log?.(`protected_execution_proxy_started credential_count=${registry.size}`);
  } catch {
    proxy?.stop();
    if (ca) disposeMitmCASync(ca);
    protectedResponseBudget.close();
    registry.clear();
    throw new Error('protected_execution_proxy_start_failed');
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      protectedResponseBudget.close();
      try {
        await proxy.close();
      } finally {
        try {
          await disposeMitmCA(ca);
        } finally {
          registry.clear();
        }
      }
    })();
    return closePromise;
  };

  return {
    childEnv,
    proxyEnv,
    port: proxy.port,
    close
  };
}

interface RouteDeps {
  isAllowed: (h: string) => boolean;
  assertDialable: AssertDialable;
  connectRaw: RawConnect;
  connectTimeoutMs: number;
  signal: AbortSignal;
  dialTimeoutMs: number;
  mitm?: MitmCA;
  filterRequest?: FilterRequest;
  rewriteRequest?: RewriteRequest;
  rewriteBody?: RewriteBody;
  responseRedactions?: ResponseRedactions;
  onProtectedResponseFailure?: ProtectedResponseFailure;
  protectedResponseBudget?: ProtectedResponseBudget;
  upstreamCA?: string | Buffer | Array<string | Buffer>;
  log?: (m: string) => void;
  trackHandle: (handle: TerminateHandle) => void;
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
  let directHeaderBlock: string | undefined;
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
    directHeaderBlock = headerBlock.replace(target, abs.path);
    initialUpstream = Buffer.concat([Buffer.from(`${headerBlock}\r\n\r\n`, 'latin1'), earlyBody]);
  }

  if (!deps.isAllowed(host)) {
    deps.log?.(`egress denied: ${host}`);
    return reply(client, '403 Forbidden');
  }
  try {
    await assertDialableBounded(host, deps.assertDialable, deps.signal, deps.dialTimeoutMs);
  } catch {
    if (deps.signal.aborted) return;
    return reply(client, '403 Forbidden');
  }
  if (deps.signal.aborted) return;

  // TLS-terminating path: an allowed CONNECT is decrypted, inspected, and re-issued upstream over a
  // fresh TLS connection with real cert validation. The allow + dialable checks above still gate it.
  const mitm = deps.mitm;
  if (isConnect && mitm) {
    await new Promise<void>((resolve, reject) => {
      try {
        terminateAndForward(
          mitm,
          deps.filterRequest,
          { hostname: host, port, upstreamCA: deps.upstreamCA },
          (handle) => {
            const { loop, close } = handle;
            deps.trackHandle(handle);
            if (deps.signal.aborted) {
              close();
              resolve();
              return;
            }
            loop.on('data', (chunk: Buffer) => client.write(chunk));
            loop.once('close', () => {
              client.data.loop = null;
              client.data.terminate = null;
              client.end();
              close();
            });
            client.data.loop = loop;
            client.data.terminate = handle;
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (initialUpstream.length > 0) loop.write(initialUpstream);
            for (const buf of client.data.pending) loop.write(buf);
            client.data.pending = [];
            resolve();
          },
          () => {
            if (!deps.signal.aborted) reply(client, '502 Bad Gateway');
            resolve();
          },
          deps.rewriteRequest,
          deps.rewriteBody,
          deps.responseRedactions,
          deps.onProtectedResponseFailure,
          deps.protectedResponseBudget
        );
      } catch (error) {
        reject(error);
      }
    });
    return;
  }

  if (!isConnect && deps.responseRedactions) {
    await new Promise<void>((resolve, reject) => {
      try {
        interceptHttpAndForward(
          deps.filterRequest,
          { hostname: host, port },
          (handle) => {
            const { loop, close } = handle;
            deps.trackHandle(handle);
            if (deps.signal.aborted) {
              close();
              resolve();
              return;
            }
            loop.on('data', (chunk: Buffer) => client.write(chunk));
            loop.once('close', () => {
              client.data.loop = null;
              client.data.terminate = null;
              client.end();
              close();
            });
            client.data.loop = loop;
            client.data.terminate = handle;
            if (initialUpstream.length > 0) loop.write(initialUpstream);
            for (const buf of client.data.pending) loop.write(buf);
            client.data.pending = [];
            resolve();
          },
          () => {
            if (!deps.signal.aborted) reply(client, '502 Bad Gateway');
            resolve();
          },
          deps.rewriteRequest,
          deps.rewriteBody,
          deps.responseRedactions,
          deps.onProtectedResponseFailure,
          deps.protectedResponseBudget
        );
      } catch (error) {
        reject(error);
      }
    });
    return;
  }

  let forwarding = false;
  let upstream: RawConnectAttempt;
  try {
    upstream = deps.connectRaw({
      hostname: host,
      port,
      onData(data) {
        if (forwarding && !deps.signal.aborted) client.write(data);
      },
      onClose() {
        if (forwarding) client.end();
      },
      onError() {
        if (forwarding) client.end();
      }
    });
    await waitForRawConnect(upstream, deps.signal, deps.connectTimeoutMs);
  } catch {
    if (deps.signal.aborted) return;
    return reply(client, '502 Bad Gateway');
  }
  if (deps.signal.aborted) {
    cancelRawAttempt(upstream);
    return;
  }

  forwarding = true;
  client.data.upstream = upstream;
  if (isConnect) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  else initialUpstream = Buffer.concat([Buffer.from(`${directHeaderBlock}\r\n\r\n`, 'latin1'), earlyBody]);
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
