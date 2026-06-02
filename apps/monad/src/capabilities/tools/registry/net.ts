// net_fetch — SSRF defence applied on every hop:
//   1. assertUrlAllowed — scheme + literal-IP / obvious-name block (pre-DNS).
//   2. DNS resolve + isBlockedIp on every resolved address — defeats DNS-rebinding
//      (a public name resolving to a private IP).
//   3. redirect:'manual' — re-run 1+2 on each Location hop; following redirects
//      automatically would bypass checks via a 302 to an internal host.
// See docs/security-guidelines.md §4.

import type { Tool } from '../types.ts';

import { lookup } from 'node:dns/promises';
import { z } from 'zod';

import { assertUrlAllowed, isBlockedIp, ToolSecurityError } from '../security.ts';
import { toolResult } from '../types.ts';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB cap on the response body
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

const netFetchInput = z.object({
  url: z.string().min(1),
  method: z.enum(['GET', 'HEAD']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1).max(120_000).optional()
});

export interface FetchResult {
  url: string; // final URL after any redirects
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

// Resolve once, validate every address, and return the URL plus the single pinned address we'll
// connect to. The caller connects to THIS IP (not by hostname) so fetch can't re-resolve to a
// different, unvalidated address between check and use (DNS-rebind TOCTOU).
async function assertHostSafe(rawUrl: string): Promise<{ url: URL; address: string }> {
  const url = assertUrlAllowed(rawUrl); // throws on bad scheme / literal-private host
  const records = await lookup(url.hostname, { all: true });
  const [first] = records;
  if (!first) throw new ToolSecurityError(`could not resolve host: ${url.hostname}`);
  for (const { address } of records) {
    if (isBlockedIp(address)) {
      throw new ToolSecurityError(`blocked host (resolves to private/loopback address): ${url.hostname} → ${address}`);
    }
  }
  return { url, address: first.address };
}

// Rewrite the URL to connect to the already-validated IP literal while preserving the path/query.
// The Host header and TLS serverName keep the original hostname so virtual hosting and certificate
// validation still work — this is what makes IP-pinning transparent to the server.
function pinnedTarget(url: URL, address: string): { url: string; host: string } {
  const literal = address.includes(':') ? `[${address}]` : address; // bracket IPv6
  const pinned = new URL(url.toString());
  pinned.hostname = literal;
  return { url: pinned.toString(), host: url.host };
}

/** Read a response body up to `maxBytes`, then abort the stream. Bounds peak memory + download. */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {}); // stop the download; ignore errors on an already-closed stream
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

/**
 * SSRF-safe text fetch shared by net_fetch and web_extract. All guards apply to both:
 * scheme/host check, DNS-rebind recheck, per-hop redirect re-validation, body cap.
 */
export async function fetchTextSafe(
  url: string,
  opts: {
    method?: 'GET' | 'HEAD';
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {}
): Promise<FetchResult> {
  // Abort on whichever comes first: the per-request timeout or the caller's cancellation.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url: safe, address } = await assertHostSafe(current);
    const target = pinnedTarget(safe, address);
    const res = await fetch(target.url, {
      method: opts.method ?? 'GET',
      headers: { ...opts.headers, host: target.host },
      // Connect to the validated IP; keep SNI/cert validation against the real hostname.
      ...(safe.protocol === 'https:' ? { tls: { serverName: safe.hostname } } : {}),
      redirect: 'manual', // re-validate each hop; automatic following bypasses SSRF checks
      signal
    } as RequestInit);

    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      if (hop === MAX_REDIRECTS) throw new ToolSecurityError(`too many redirects (> ${MAX_REDIRECTS})`);
      current = new URL(res.headers.get('location') as string, safe).toString();
      continue;
    }

    // Stream the body and stop at maxBytes so the cap bounds memory/bandwidth, not just the
    // returned string — `await res.arrayBuffer()` would download a hostile multi-GB body in full.
    const { text, truncated } = await readCapped(res, maxBytes);
    return {
      url: safe.toString(),
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: text,
      truncated
    };
  }
  throw new ToolSecurityError('redirect loop did not terminate'); // unreachable
}

export const netFetchTool: Tool<z.infer<typeof netFetchInput>, FetchResult> = {
  name: 'net_fetch',
  description: 'Fetch an http(s) URL and return status, headers, and the response body as text (size-capped).',
  scopes: [{ resource: 'net:fetch' }],
  inputSchema: netFetchInput,
  run: ({ url, method, headers, timeoutMs }, ctx) =>
    fetchTextSafe(url, { method, headers, timeoutMs, signal: ctx.signal }).then((result) => toolResult(result))
};

const netTools: Tool[] = [netFetchTool as Tool];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => netTools;
