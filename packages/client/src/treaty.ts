import type { Treaty } from '@elysiajs/eden';
import type { App } from '@monad/monad';

import { treaty } from '@elysiajs/eden';

export interface MonadTreatyOptions {
  /** Daemon base URL, e.g. "https://127.0.0.1:52749". */
  baseUrl: string;
  /** Bearer token for the control API (header only — never in the URL). */
  token?: string;
  /**
   * Absolute path to the daemon's Unix-domain HTTP socket. When set, every REST/SSE
   * request is dialed over this socket (Bun's `fetch({ unix })`) instead of TCP — the
   * `baseUrl` host is then only used to build paths and the Host header. Local only.
   */
  unixSocket?: string;
}

type MonadApp = App;
export type MonadTreaty = Treaty.Create<MonadApp>;
export type MonadTreatyConfig = Treaty.Config;

type DebugTrace = (entry: {
  direction: 'input' | 'output' | 'event' | 'internal' | 'error';
  layer: 'web' | 'http' | 'sse' | 'daemon' | 'log';
  label: string;
  data?: unknown;
  sessionId?: string;
}) => void;

declare global {
  var __MONAD_DEBUG_TRACE__: DebugTrace | undefined;
}

function mergeTreatyHeaders(
  token: string | undefined,
  headers: MonadTreatyConfig['headers']
): MonadTreatyConfig['headers'] {
  if (!token) return headers;

  const authHeader = { authorization: `Bearer ${token}` };
  if (!headers) return authHeader;
  return Array.isArray(headers) ? [authHeader, ...headers] : [authHeader, headers];
}

export function createMonadTreaty(opts: MonadTreatyOptions, config?: MonadTreatyConfig): MonadTreaty {
  const base = opts.baseUrl.replace(/\/$/, '');
  const transport =
    makeUnixFetcher(opts.unixSocket, opts.baseUrl) ??
    makeLoopbackHttpsFetcher(opts.baseUrl) ??
    config?.fetcher ??
    fetch;
  // Dev-only request tracing (captures request bodies into the developer console). Gated on
  // NODE_ENV so makeTracingFetcher + requestBody dead-code-eliminate from release builds.
  const fetcher = process.env.NODE_ENV !== 'production' ? makeTracingFetcher(transport) : transport;
  return treaty<MonadApp>(base, {
    ...config,
    parseDate: false,
    fetcher,
    headers: mergeTreatyHeaders(opts.token, config?.headers)
  });
}

function requestMethod(init: RequestInit | undefined, input: RequestInfo | URL): string {
  if (init?.method) return init.method;
  if (input instanceof Request) return input.method;
  return 'GET';
}

function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body === 'string') return body.length > 4096 ? `${body.slice(0, 4096)}…` : body;
  if (body === undefined || body === null) return undefined;
  return Object.prototype.toString.call(body);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function makeTracingFetcher(baseFetcher: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = requestMethod(init, input);
    const startedAt = performance.now();
    globalThis.__MONAD_DEBUG_TRACE__?.({
      direction: 'input',
      layer: 'http',
      label: `${method} ${url}`,
      data: { method, url, body: requestBody(init) }
    });
    try {
      const response = await baseFetcher(input, init);
      globalThis.__MONAD_DEBUG_TRACE__?.({
        direction: 'output',
        layer: 'http',
        label: `${method} ${url}`,
        data: {
          status: response.status,
          ok: response.ok,
          contentType: response.headers.get('content-type'),
          latencyMs: Math.round(performance.now() - startedAt)
        }
      });
      return response;
    } catch (error) {
      if (init?.signal?.aborted || isAbortError(error)) {
        globalThis.__MONAD_DEBUG_TRACE__?.({
          direction: 'internal',
          layer: 'http',
          label: `${method} ${url}`,
          data: {
            aborted: true,
            message: error instanceof Error ? error.message : String(error),
            latencyMs: Math.round(performance.now() - startedAt)
          }
        });
        throw error;
      }
      globalThis.__MONAD_DEBUG_TRACE__?.({
        direction: 'error',
        layer: 'http',
        label: `${method} ${url}`,
        data: {
          message: error instanceof Error ? error.message : String(error),
          latencyMs: Math.round(performance.now() - startedAt)
        }
      });
      throw error;
    }
  }) as typeof fetch;
}

/**
 * On a UDS connect failure (socket missing or daemon not listening), retries over TCP
 * and latches to TCP for the client's lifetime. CLI processes are short-lived so the
 * next invocation re-probes. Returns undefined when no socket is configured (Eden uses
 * plain TCP by default).
 */
export function makeUnixFetcher(unixSocket: string | undefined, baseUrl?: string): typeof fetch | undefined {
  if (!unixSocket) return undefined;
  let fellBackToTcp = false;
  const tcpFetch = (baseUrl ? makeLoopbackHttpsFetcher(baseUrl) : undefined) ?? fetch;
  const unixFetch = async (input: RequestInfo | URL, init?: BunFetchRequestInit): Promise<Response> => {
    if (!fellBackToTcp) {
      try {
        // `unix` is Bun-only (BunFetchRequestInit).
        return await fetch(rewriteLoopbackHttpsInputToHttp(input), { ...init, unix: unixSocket });
      } catch {
        // Connect-level failure: the request never reached the daemon, so retrying
        // over TCP (baseUrl = 127.0.0.1:<port>) is safe. No timeout added here —
        // connect errors throw promptly, and a timeout would abort SSE streams.
        fellBackToTcp = true;
      }
    }
    return tcpFetch(input, init);
  };
  return unixFetch as typeof fetch;
}

function rewriteLoopbackHttpsInputToHttp(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === 'string') return rewriteLoopbackHttpsUrlToHttp(input);
  if (input instanceof URL) return new URL(rewriteLoopbackHttpsUrlToHttp(input.toString()));
  return new Request(rewriteLoopbackHttpsUrlToHttp(input.url), input);
}

function rewriteLoopbackHttpsUrlToHttp(raw: string): string {
  try {
    const url = new URL(raw);
    if (
      url.protocol === 'https:' &&
      (url.hostname === '127.0.0.1' ||
        url.hostname === 'localhost' ||
        url.hostname === '::1' ||
        url.hostname === '[::1]')
    ) {
      url.protocol = 'http:';
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * When the daemon uses a self-signed TLS cert on loopback, normal cert verification fails.
 * This fetcher skips it — safe because 127.0.0.1/::1 traffic never leaves the machine,
 * so there is no remote MITM vector. Returns undefined for non-loopback or non-HTTPS URLs.
 */
export function makeLoopbackHttpsFetcher(baseUrl: string): typeof fetch | undefined {
  if (!baseUrl.startsWith('https://')) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') return undefined;
  return ((input, init) =>
    fetch(input, { ...init, tls: { rejectUnauthorized: false } } as BunFetchRequestInit)) as typeof fetch;
}
