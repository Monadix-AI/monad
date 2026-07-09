// In-process TLS termination for HTTPS traffic through the egress proxy.
//
// When a MitmCA is configured, the proxy hands an allowed CONNECT here instead of opening an opaque
// byte tunnel. We terminate the client's TLS with a per-host leaf cert (see ca.ts), parse the
// decrypted stream as HTTP/1.1, and re-issue each request upstream over a REAL TLS connection with
// normal cert validation on the proxy→server leg. The optional `filterRequest` callback runs on
// each parsed request before it is forwarded.
//
// The client side of this proxy runs on a Bun socket, which is not a Node Duplex, so we cannot feed
// it to an https.Server directly. Instead we stand up a short-lived https.Server on a unix socket,
// connect a Node client (`loop`) to it, and return that Node socket. The caller bridges the Bun
// client's plaintext-TLS bytes to/from `loop`. A per-connection server lets the request handler
// close over `target` without socket-keyed lookups, and works under both Node and Bun (Bun does not
// implement server.emit('connection', socket)).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket as NodeSocket } from 'node:net';
import type { Readable } from 'node:stream';
import type { MitmCA } from './ca.ts';

import { unlink } from 'node:fs';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { logger } from '@monad/logger';

/** Decision returned by a filterRequest hook. Deny → the proxy answers 403 and drops the request. */
export interface FilterDecision {
  allow: boolean;
}

/** Called for each decrypted request before it is forwarded upstream. Default: allow. */
export type FilterRequest = (req: IncomingMessage) => FilterDecision | Promise<FilterDecision>;

/**
 * Rewrite the outbound request-head (request line + headers, CRLF-joined, no trailing blank line)
 * on the proxy→server leg, keyed by the upstream `host`. Used for credential-sentinel substitution:
 * the returned block replaces the forwarded headers. Runs AFTER filterRequest, on the outbound leg
 * only — the child and the response never see the rewritten value. The response body is NOT rewritten
 * (out of scope; body rewriting is a follow-up).
 */
export type RewriteRequest = (host: string, rawHeaderBlock: string) => string;

/**
 * Rewrite the outbound request BODY on the proxy→server leg (sentinel→real for the host's injectHosts),
 * same contract as RewriteRequest but over the body text. Applied only to a bounded, non-chunked,
 * valid-UTF-8 body — a chunked/oversized/binary body is forwarded unchanged (fail-safe: the sentinel
 * reaches upstream, so that credential simply doesn't authenticate, but the request is never mangled).
 */
export type RewriteBody = (host: string, body: string) => string;

// Only buffer+rewrite a body up to this size; larger bodies stream through untouched.
const MAX_BODY_REWRITE_BYTES = 1024 * 1024;

export interface TerminateTarget {
  hostname: string;
  port: number;
  /**
   * Extra CA(s) trusted on the proxy's OUTBOUND leg. Unset → system roots + NODE_EXTRA_CA_CERTS.
   * A test seam only: NODE_EXTRA_CA_CERTS is read at process start, so a suite testing against a
   * self-signed upstream cannot set it from inside the test. It NEVER disables verification.
   */
  upstreamCA?: string | Buffer | Array<string | Buffer>;
}

export interface TerminateHandle {
  /** The Node socket bridged to the inner TLS server. Bun-client TLS bytes flow through this. */
  loop: NodeSocket;
  /** Tear down the inner server + loop socket. Idempotent. */
  close(): void;
}

/**
 * Terminate the client's TLS, parse the decrypted HTTP/1.1 stream, and forward each request to
 * `target` over a fresh upstream TLS connection. Returns a Node socket the caller pipes the Bun
 * client's bytes through.
 *
 * Precondition: the caller has already validated `target` against the domain allowlist and DNS
 * (isAllowed + assertDialable). This function does NOT re-check it.
 */
export function terminateAndForward(
  ca: MitmCA,
  filterRequest: FilterRequest | undefined,
  target: TerminateTarget,
  onReady: (handle: TerminateHandle) => void,
  onError: () => void,
  rewriteRequest?: RewriteRequest,
  rewriteBody?: RewriteBody
): void {
  const baseLeaf = ca.leafForHost(target.hostname);
  const inner = createHttpsServer({
    // ALPN advertises HTTP/1.1 only — terminating HTTP/2 needs a frame parser; clients negotiate down.
    ALPNProtocols: ['http/1.1'],
    cert: baseLeaf.cert,
    key: baseLeaf.key,
    SNICallback: (servername, cb) => {
      try {
        const leaf = ca.leafForHost(servername || target.hostname);
        cb(null, createSecureContext({ cert: leaf.cert, key: leaf.key }));
      } catch (err) {
        cb(err as Error);
      }
    }
  });

  inner.on('request', (req, res) => {
    void forwardUpstream(filterRequest, rewriteRequest, rewriteBody, req, res, target);
  });
  inner.on('tlsClientError', (err, sock) => {
    logger.error(`tls-terminate: client TLS error for ${target.hostname}: ${err.message}`);
    sock.destroy();
  });
  inner.on('upgrade', (_req, sock) => {
    // WebSocket / non-HTTP over TLS — out of scope for now.
    logger.warn('tls-terminate: upgrade request refused');
    sock.destroy();
  });

  const sockPath = innerSocketPath();
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    inner.close();
    unlink(sockPath, () => {});
  };

  inner.on('error', (err) => {
    logger.error(`tls-terminate: inner server listen failed: ${err.message}`);
    cleanup();
    onError();
  });
  inner.listen(sockPath, () => {
    const loop = connect({ path: sockPath });
    loop.on('error', (err) => {
      logger.error(`tls-terminate: inner loopback failed: ${err.message}`);
      cleanup();
      onError();
    });
    loop.once('connect', () => {
      onReady({
        loop,
        close: () => {
          loop.destroy();
          cleanup();
        }
      });
    });
    loop.once('close', () => cleanup());
  });
  inner.unref();
}

async function forwardUpstream(
  filterRequest: FilterRequest | undefined,
  rewriteRequest: RewriteRequest | undefined,
  rewriteBody: RewriteBody | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  target: TerminateTarget
): Promise<void> {
  if (filterRequest) {
    let decision: FilterDecision;
    try {
      decision = await filterRequest(req);
    } catch (err) {
      logger.error(`tls-terminate: filterRequest threw for ${target.hostname}: ${(err as Error).message}`);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
      return;
    }
    if (!decision.allow) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      req.resume(); // drain the request body so the socket can be reused/closed cleanly
      return;
    }
  }

  // req.url is the request-target verbatim; normalize to origin-form so it concatenates onto the
  // CONNECT-verified https://host below. Discard any client-supplied absolute authority — the
  // CONNECT target stays authoritative (a spoofed Host must not redirect the delivery).
  const path = originFormPath(req.url);

  // Drop the Host header and let the runtime derive it from {host, port}: Bun's https.request
  // verifies the upstream cert against headers.host verbatim (incl. ":port"), which never matches a
  // SAN. Same wire value, correct verification under both Node and Bun.
  let fwdHeaders = { ...req.headers };
  delete fwdHeaders.host;

  // Credential-sentinel substitution on the OUTBOUND leg only: serialize the header block, hand it
  // to the host-keyed rewriter (sentinel→real for matching injectHosts), and re-parse. Keeps the
  // real value out of the child and the response; body is not rewritten (follow-up).
  if (rewriteRequest) {
    const block = serializeHeaderBlock(req.method ?? 'GET', path, fwdHeaders);
    const rewritten = rewriteRequest(target.hostname, block);
    if (rewritten !== block) fwdHeaders = parseHeaderBlock(rewritten, fwdHeaders);
  }

  // Body substitution on the OUTBOUND leg: a secret sent in a POST/PUT body (JSON/form) is a sentinel
  // in the child; swap it for the real value here, for matching injectHosts only. Bounded + fail-safe:
  // chunked, oversized, or non-UTF-8 bodies stream through untouched (that credential just won't apply).
  let bodyBuf: Buffer | undefined;
  if (rewriteBody) {
    const chunked = String(fwdHeaders['transfer-encoding'] ?? '')
      .toLowerCase()
      .includes('chunked');
    const contentLength = Number(fwdHeaders['content-length']);
    if (!chunked && Number.isFinite(contentLength) && contentLength > 0 && contentLength <= MAX_BODY_REWRITE_BYTES) {
      try {
        bodyBuf = await readBounded(req, MAX_BODY_REWRITE_BYTES);
      } catch (err) {
        // Client reset mid-body → don't leave the promise floating (unhandledRejection). The stream is
        // dead; answer 400 and stop rather than forward a half-read body.
        logger.warn(`tls-terminate: body read failed for ${target.hostname}: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        } else {
          res.destroy();
        }
        return;
      }
      const text = bodyBuf.toString('utf8');
      // Substitute only valid UTF-8 (a sentinel round-trips through UTF-8); binary bodies pass unchanged.
      if (Buffer.byteLength(text, 'utf8') === bodyBuf.length) {
        const rewritten = rewriteBody(target.hostname, text);
        if (rewritten !== text) {
          bodyBuf = Buffer.from(rewritten, 'utf8');
          fwdHeaders['content-length'] = String(bodyBuf.length);
        }
      }
    }
  }

  const upstream = httpsRequest(
    {
      host: target.hostname,
      port: target.port,
      path,
      method: req.method,
      headers: fwdHeaders,
      // rejectUnauthorized defaults to true — the proxy→server leg keeps REAL cert validation.
      // servername must match the intended host; SNI cannot carry an IP literal, and Bun's
      // https.request distinguishes `servername: undefined` from an omitted key, so spread it.
      ...(isIP(target.hostname) ? {} : { servername: target.hostname }),
      ...(target.upstreamCA ? { ca: target.upstreamCA } : {}),
      // No global agent: a proxy's outbound leg must not share a pool keyed on the proxy process,
      // and Bun caches the first request's `ca:` on the global agent otherwise.
      agent: false
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    logger.error(`tls-terminate: upstream ${target.hostname}:${target.port} failed: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    } else {
      res.destroy();
    }
  });

  res.on('close', () => upstream.destroy());
  // If we buffered the body to rewrite it, req is already consumed — send the (possibly rewritten)
  // buffer. Otherwise stream the untouched body straight through.
  if (bodyBuf !== undefined) upstream.end(bodyBuf);
  else (req as Readable).pipe(upstream);
}

// Read up to `cap` bytes of a request body into one buffer. Content-Length already bounds it to ≤ cap;
// the guard is defence in depth against a lying length.
async function readBounded(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= cap) break;
  }
  return Buffer.concat(chunks);
}

type Headers = IncomingMessage['headers'];

// Serialize the request line + headers into a raw HTTP/1.1 head (no trailing blank line), the shape
// the rewriter substitutes over. Array-valued headers (repeated names) emit one line each.
function serializeHeaderBlock(method: string, path: string, headers: Headers): string {
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) lines.push(`${name}: ${v}`);
    else lines.push(`${name}: ${value}`);
  }
  return lines.join('\r\n');
}

// Re-parse a rewritten head back into a headers object, preserving the original for any name the
// block no longer carries (defensive — the rewriter only substitutes values, never drops headers).
// The request line is ignored: the path/method are already captured before rewriting.
function parseHeaderBlock(block: string, original: Headers): Headers {
  const out: Headers = {};
  const lines = block.split('\r\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trimStart();
    const existing = out[name];
    if (existing === undefined) out[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[name] = [existing, value];
  }
  // A header present in the original but absent from the rewritten block would silently vanish;
  // that never happens for value-only substitution, but keep the original if the parse produced
  // nothing (malformed rewrite) so we don't strip the request.
  return Object.keys(out).length > 0 ? out : original;
}

function originFormPath(reqUrl: string | undefined): string {
  const raw = reqUrl ?? '/';
  if (raw.startsWith('/')) return raw;
  try {
    const u = new URL(raw);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return raw;
  }
}

let sockSeq = 0;
function innerSocketPath(): string {
  // Keep it short — macOS sun_path is 104 bytes.
  return join(tmpdir(), `monad-tt-${process.pid}-${(sockSeq++).toString(36)}.sock`);
}
