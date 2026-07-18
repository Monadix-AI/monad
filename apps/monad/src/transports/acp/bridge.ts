// Bridge handlers: an AcpHandlers implementation that proxies to an already-running daemon over its
// Unix socket (REST + inline SSE) instead of holding the daemon in-process. This is what lets
// `monad acp` attach to a shared daemon — the same one backing the Web UI/CLI — so editor sessions
// appear there and reuse one store/model config.
//
// We deliberately do NOT depend on @monad/client here: that package targets the DOM and the daemon
// compiles against Bun-only libs, and pulling it in would create a monad→client→monad cycle. The
// client surface the bridge needs is tiny (a handful of REST calls + one SSE consumer), so we build
// it directly on Bun's fetch and validate streamed events with the protocol schema.
//
// Phase 1 (non-delegated): a turn runs on the daemon host with the daemon's own sandbox. The
// permission + clarify round-trips already work cross-process because the daemon folds those
// out-of-band events into the inline SSE response (createSessionMessageSseResponse), and the adapter
// answers them via the oversight/clarify proxy methods below. fs/terminal delegation and per-session
// sandbox roots arrive in later phases.

import type { SessionOrigin, SessionTransport } from '@monad/protocol';
import type { EventSink } from '#/handlers/session/index.ts';
import type { AcpHandlers } from '#/transports/acp/connection.ts';

import { createLogger } from '@monad/logger';
import { eventSchema, readTypedSseStream } from '@monad/protocol';

const log = createLogger('transport:acp:bridge');

export interface BridgeOptions {
  /** Daemon base URL (e.g. https://127.0.0.1:47749). With `unixSocket` set, the host/port is only
   * used to build the URL + Host header; requests dial the socket. */
  baseUrl: string;
  /** TCP fallback base URL. When omitted, fallback reuses `baseUrl`. */
  tcpBaseUrl?: string;
  /** Daemon Unix-domain HTTP socket. Local daemons only. */
  unixSocket?: string;
  token?: string;
}

type FetchInit = RequestInit & { unix?: string };

/** Bun's fetch accepts a `unix` option to dial a Unix-domain socket; the global RequestInit type
 * doesn't model it, so we widen locally. */
function bunFetch(url: string, init: FetchInit): Promise<Response> {
  return fetch(url, init as RequestInit);
}

// An editor session's default origin permits only the 'acp' transport, but the bridge reaches the
// daemon over the local HTTP socket — both the inline-SSE send (stream.ts stamps 'http') and the
// branch controller would otherwise be refused. Since ACP is now ALWAYS proxied over this local
// (owner-trusted) socket, widen the write/branch policy of sessions the bridge creates to allow
// 'http' too. The daemon honours a client-supplied writableBy/branchableBy on create/branch.
function allowHttpTransport(origin?: SessionOrigin): SessionOrigin | undefined {
  if (!origin) return origin;
  const withHttp = (arr?: SessionTransport[]): SessionTransport[] =>
    Array.from(new Set<SessionTransport>([...(arr ?? []), 'http']));
  return { ...origin, writableBy: withHttp(origin.writableBy), branchableBy: withHttp(origin.branchableBy) };
}

function buildQuery(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Build an {@link AcpHandlers} backed by the daemon at `opts.baseUrl`/`opts.unixSocket`. The object
 * is type-checked against the real handler surface (AcpHandlers is a `Pick` of it); parsed JSON is
 * cast to each method's declared return at this wire boundary — daemon and bridge derive the same
 * shapes from @monad/protocol, so the runtime values match.
 */
export function createBridgeHandlers(opts: BridgeOptions): { handlers: AcpHandlers } {
  const base = opts.baseUrl.replace(/\/$/, '');
  const tcpBase = (opts.tcpBaseUrl ?? opts.baseUrl).replace(/\/$/, '');
  const authHeaders: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};

  // Dial the Unix socket when configured; on a connect-level failure (socket missing / daemon not
  // listening) retry over TCP (the URL already carries baseUrl host:port) and latch to TCP for this
  // bridge's lifetime — mirrors the CLI client's fetcher so `monad acp` survives a stale socket.
  let fellBackToTcp = false;
  async function bridgeFetch(url: string, init: FetchInit): Promise<Response> {
    if (opts.unixSocket && !fellBackToTcp) {
      try {
        return await bunFetch(url, { ...init, unix: opts.unixSocket });
      } catch {
        fellBackToTcp = true;
      }
    }
    return bunFetch(tcpFallbackUrl(url), init);
  }

  function tcpFallbackUrl(url: string): string {
    if (base === tcpBase || !url.startsWith(base)) return url;
    return `${tcpBase}${url.slice(base.length)}`;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: FetchInit = {
      method,
      headers: { ...authHeaders, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    };
    const res = await bridgeFetch(`${base}${path}`, init);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`daemon ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()) as T;
  }

  const get = <T>(path: string) => request<T>('GET', path);
  const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
  const put = <T>(path: string, body?: unknown) => request<T>('PUT', path, body);
  const del = <T>(path: string) => request<T>('DELETE', path);

  /** Run a turn over the daemon's inline-SSE path and replay each event into the ACP sink. The
   * daemon folds out-of-band oversight/clarify events into this same stream, so the adapter's sink
   * sees and bridges them. Resolves when the stream closes (turn end). */
  async function streamTurn(
    sessionId: string,
    text: string,
    ambientContext: string | undefined,
    sink: EventSink
  ): Promise<void> {
    const init: FetchInit = {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ text, ambientContext })
    };
    const res = await bridgeFetch(`${base}/v1/sessions/${sessionId}/messages`, init);
    if (!res.ok || !res.body) {
      throw new Error(`daemon turn failed (${res.status})`);
    }
    await readTypedSseStream(res.body.getReader(), eventSchema, sink, {
      onInvalid: (err) => log.warn({ err }, 'dropping unparseable session event')
    });
  }

  const handlers: AcpHandlers = {
    session: {
      create: (args) => post('/v1/sessions', { ...args, origin: allowHttpTransport(args.origin) }),
      get: ({ id }) => get(`/v1/sessions/${id}`),
      branch: ({ id, title, atMessageId, origin }) =>
        post(`/v1/sessions/${id}/branch`, { title, atMessageId, origin: allowHttpTransport(origin) }),
      list: (params = {}) => get(`/v1/sessions${buildQuery(params)}`),
      messages: ({ id, limit, before, includeInactive }) =>
        get(`/v1/sessions/${id}/messages${buildQuery({ limit, before, includeInactive })}`),
      delete: ({ id }) => del(`/v1/sessions/${id}`),
      abort: ({ id }) => post(`/v1/sessions/${id}/abort`),
      restore: ({ id, toMessageId }) => post(`/v1/sessions/${id}/restore`, { toMessageId }),
      configureRuntime: ({ id, sandboxRoots, mcpServers, delegate }) =>
        put(`/v1/sessions/${id}/runtime`, { sandboxRoots, mcpServers, delegate }),
      sendInline: async ({ sessionId, text }, sink: EventSink, runOpts) => {
        await streamTurn(sessionId, text, runOpts?.ambientContext, sink);
      }
    },
    commands: {
      list: () => get('/v1/commands')
    },
    oversight: {
      approve: (body) => post('/v1/tools/approve', body)
    },
    clarify: {
      respond: (body) => post('/v1/clarifications/respond', body)
    },
    delegation: {
      respond: (body) => post('/v1/delegation/respond', body),
      output: (body) => post('/v1/delegation/output', body)
    },
    model: {
      listProviders: () => get('/v1/settings/model/providers'),
      listModels: ({ providerId }: { providerId: string }) => get(`/v1/settings/model/providers/${providerId}/models`),
      listProfiles: () => get('/v1/settings/model/profiles'),
      getDefaultProfile: () => get('/v1/settings/model/default'),
      setDefaultProfile: (body: { alias: string }) => put('/v1/settings/model/default', body)
    }
  };

  return { handlers };
}
