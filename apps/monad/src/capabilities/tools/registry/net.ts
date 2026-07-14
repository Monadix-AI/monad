// net_fetch — SSRF defence applied on every hop:
//   1. assertUrlAllowed — scheme + literal-IP / obvious-name block (pre-DNS).
//   2. DNS resolve + isBlockedIp on every resolved address — defeats DNS-rebinding
//      (a public name resolving to a private IP).
//   3. redirect:'manual' — re-run 1+2 on each Location hop; following redirects
//      automatically would bypass checks via a 302 to an internal host.
// See docs/engineering/security-guidelines.md §4.

import type { Tool, ToolContext } from '../types.ts';

import { lookup } from 'node:dns/promises';
import { httpUrlSchema } from '@monad/protocol';
import { assertUrlAllowed, isBlockedIp, normalizeHost, ToolSecurityError } from '@monad/sandbox';
import { z } from 'zod';

import { defaultApprovalPolicy } from '../approval/policy.ts';
import { approvalDeniedMessage, requestNetworkAccess } from '../approval/resource-approval.ts';
import { toolResult } from '../types.ts';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB cap on the response body
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

const netFetchInput = z.object({
  url: httpUrlSchema,
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

function shouldRequestNetworkApproval(ctx: ToolContext): boolean {
  return defaultApprovalPolicy.shouldRequestNetworkApproval(ctx);
}

async function approveNetworkAccess(
  ctx: ToolContext,
  request: { url: string; host: string; protocol: 'http' | 'https'; reason: string },
  approvedHosts?: Set<string>
): Promise<string> {
  const host = normalizeHost(request.host);
  if (!shouldRequestNetworkApproval(ctx) || approvedHosts?.has(host)) return host;
  const outcome = await requestNetworkAccess(ctx, { ...request, host });
  if (!outcome.allow) throw new ToolSecurityError(approvalDeniedMessage('network', host));
  approvedHosts?.add(host);
  return host;
}

export function createApprovalFetch(
  ctx: ToolContext,
  opts: { reason: string; fetchImpl?: typeof fetch; approvedHosts?: Set<string> }
): typeof fetch {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const approvedHosts = opts.approvedHosts ?? new Set<string>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input.toString(), init);
    const checked = assertUrlAllowed(request.url);
    await approveNetworkAccess(
      ctx,
      {
        url: checked.toString(),
        host: checked.hostname,
        protocol: checked.protocol === 'https:' ? 'https' : 'http',
        reason: opts.reason
      },
      approvedHosts
    );
    return fetchImpl(request);
  }) as typeof fetch;
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
    approval?: { ctx: ToolContext; reason: string };
    approvedHosts?: Set<string>;
  } = {}
): Promise<FetchResult> {
  // Abort on whichever comes first: the per-request timeout or the caller's cancellation.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  const approvedHosts = opts.approvedHosts ?? new Set<string>();
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = assertUrlAllowed(current);
    const host = normalizeHost(checked.hostname);
    if (opts.approval) {
      await approveNetworkAccess(
        opts.approval.ctx,
        {
          url: checked.toString(),
          host,
          protocol: checked.protocol === 'https:' ? 'https' : 'http',
          reason: opts.approval.reason
        },
        approvedHosts
      );
    }
    const { url: safe, address } = await assertHostSafe(checked.toString());
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
    fetchTextSafe(url, { method, headers, timeoutMs, signal: ctx.signal, approval: { ctx, reason: 'net_fetch' } }).then(
      (result) => toolResult(result)
    )
};

const netTools: Tool[] = [netFetchTool as Tool];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => netTools;
