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

import type { ClientRequest, Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket as NodeSocket } from 'node:net';
import type { Readable } from 'node:stream';
import type { MitmCA } from './ca.ts';

import { unlink } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { logger } from '@monad/logger';

import {
  decodeCredentialUtf8,
  forwardProtectedCredentialResponse,
  isCredentialTextualContentType,
  type ProtectedResponseBudget,
  type ProtectedResponseFailure,
  type ResponseRedactions
} from '../credential-redaction-stream.ts';

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
 * only — the child and the response never see the rewritten value.
 */
export type RewriteRequest = (host: string, rawHeaderBlock: string) => string;

/**
 * Rewrite the outbound request BODY on the proxy→server leg (sentinel→real for the host's injectHosts),
 * same contract as RewriteRequest but over the body text. Applied only to a bounded, non-chunked,
 * valid-UTF-8 body — a chunked/oversized/binary body is forwarded unchanged (fail-safe: the sentinel
 * reaches upstream, so that credential simply doesn't authenticate, but the request is never mangled).
 */
export type RewriteBody = (host: string, body: string) => string;

const MAX_BODY_REWRITE_BYTES = 1024 * 1024;
const MAX_HEADER_REWRITE_BYTES = 64 * 1024;

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
  readonly closed: Promise<void>;
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
  rewriteBody?: RewriteBody,
  responseRedactions?: ResponseRedactions,
  onProtectedResponseFailure?: ProtectedResponseFailure,
  protectedResponseBudget?: ProtectedResponseBudget
): void {
  const activeTasks = new Set<Promise<void>>();
  const trackTask = taskTracker(activeTasks);
  const activeUpstreams = new Set<ClientRequest>();
  const trackUpstream = upstreamTracker(activeUpstreams);
  const activeResponses = new Set<IncomingMessage>();
  const trackResponse = responseTracker(activeResponses);
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
    trackTask(
      forwardUpstream(
        filterRequest,
        rewriteRequest,
        rewriteBody,
        responseRedactions,
        onProtectedResponseFailure,
        protectedResponseBudget,
        trackTask,
        trackUpstream,
        trackResponse,
        req,
        res,
        target,
        true
      )
    );
  });
  inner.on('tlsClientError', (_err, sock) => {
    logger.error('tls_terminate_client_error');
    sock.destroy();
  });
  inner.on('upgrade', (_req, sock) => {
    // WebSocket / non-HTTP over TLS — out of scope for now.
    logger.warn('tls_terminate_upgrade_refused');
    sock.destroy();
  });

  startInnerServer(
    inner,
    onReady,
    onError,
    () => {
      for (const upstream of activeUpstreams) upstream.destroy();
      for (const response of activeResponses) response.destroy();
    },
    () => Promise.allSettled(activeTasks).then(() => {})
  );
}

export function interceptHttpAndForward(
  filterRequest: FilterRequest | undefined,
  target: TerminateTarget,
  onReady: (handle: TerminateHandle) => void,
  onError: () => void,
  rewriteRequest?: RewriteRequest,
  rewriteBody?: RewriteBody,
  responseRedactions?: ResponseRedactions,
  onProtectedResponseFailure?: ProtectedResponseFailure,
  protectedResponseBudget?: ProtectedResponseBudget
): void {
  const activeTasks = new Set<Promise<void>>();
  const trackTask = taskTracker(activeTasks);
  const activeUpstreams = new Set<ClientRequest>();
  const trackUpstream = upstreamTracker(activeUpstreams);
  const activeResponses = new Set<IncomingMessage>();
  const trackResponse = responseTracker(activeResponses);
  const inner = createHttpServer((req, res) => {
    trackTask(
      forwardUpstream(
        filterRequest,
        rewriteRequest,
        rewriteBody,
        responseRedactions,
        onProtectedResponseFailure,
        protectedResponseBudget,
        trackTask,
        trackUpstream,
        trackResponse,
        req,
        res,
        target,
        false
      )
    );
  });
  inner.on('upgrade', (_req, sock) => {
    logger.warn('tls_terminate_upgrade_refused');
    sock.destroy();
  });
  startInnerServer(
    inner,
    onReady,
    onError,
    () => {
      for (const upstream of activeUpstreams) upstream.destroy();
      for (const response of activeResponses) response.destroy();
    },
    () => Promise.allSettled(activeTasks).then(() => {})
  );
}

async function forwardUpstream(
  filterRequest: FilterRequest | undefined,
  rewriteRequest: RewriteRequest | undefined,
  rewriteBody: RewriteBody | undefined,
  responseRedactions: ResponseRedactions | undefined,
  onProtectedResponseFailure: ProtectedResponseFailure | undefined,
  protectedResponseBudget: ProtectedResponseBudget | undefined,
  trackTask: (task: Promise<void>) => void,
  trackUpstream: (upstream: ClientRequest) => void,
  trackResponse: (response: IncomingMessage) => void,
  req: IncomingMessage,
  res: ServerResponse,
  target: TerminateTarget,
  secure: boolean
): Promise<void> {
  if (filterRequest) {
    let decision: FilterDecision;
    try {
      decision = await filterRequest(req);
    } catch {
      logger.error('tls_terminate_filter_failed');
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
  let path = originFormPath(req.url);

  // Drop the Host header and let the runtime derive it from {host, port}: Bun's https.request
  // verifies the upstream cert against headers.host verbatim (incl. ":port"), which never matches a
  // SAN. Same wire value, correct verification under both Node and Bun.
  let fwdHeaders = { ...req.headers };
  delete fwdHeaders.host;
  fwdHeaders['accept-encoding'] = 'identity';

  // Credential-sentinel substitution on the OUTBOUND leg only: serialize the header block, hand it
  // to the host-keyed rewriter (sentinel→real for matching injectHosts), and re-parse.
  if (rewriteRequest) {
    const block = serializeHeaderBlock(req.method ?? 'GET', path, fwdHeaders);
    const rewritten = rewriteRequest(target.hostname, block);
    if (Buffer.byteLength(rewritten, 'utf8') > MAX_HEADER_REWRITE_BYTES) {
      res.writeHead(431, { 'Content-Type': 'text/plain' });
      res.end('Request Header Fields Too Large');
      req.resume();
      return;
    }
    if (rewritten !== block) {
      const parsed = parseHeaderBlock(rewritten, fwdHeaders, path);
      path = parsed.path;
      fwdHeaders = parsed.headers;
    }
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
    const textual = isCredentialTextualContentType(String(fwdHeaders['content-type'] ?? ''));
    if (
      textual &&
      !chunked &&
      Number.isFinite(contentLength) &&
      contentLength > 0 &&
      contentLength <= MAX_BODY_REWRITE_BYTES
    ) {
      try {
        bodyBuf = await readBounded(req, MAX_BODY_REWRITE_BYTES);
      } catch {
        // Client reset mid-body → don't leave the promise floating (unhandledRejection). The stream is
        // dead; answer 400 and stop rather than forward a half-read body.
        logger.warn('tls_terminate_request_body_read_failed');
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        } else {
          res.destroy();
        }
        return;
      }
      const text = decodeCredentialUtf8(bodyBuf);
      if (text !== undefined) {
        const rewritten = rewriteBody(target.hostname, text);
        if (rewritten !== text) {
          bodyBuf = Buffer.from(rewritten, 'utf8');
          if (bodyBuf.length > MAX_BODY_REWRITE_BYTES) {
            res.writeHead(413, { 'Content-Type': 'text/plain' });
            res.end('Payload Too Large');
            return;
          }
          fwdHeaders['content-length'] = String(bodyBuf.length);
        }
      }
    }
  }

  let receivedResponse = false;
  const onResponse = (upRes: IncomingMessage): void => {
    receivedResponse = true;
    trackResponse(upRes);
    if (!responseRedactions) {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
      return;
    }
    trackTask(
      forwardProtectedCredentialResponse(
        req.method,
        upRes,
        res,
        responseRedactions(target.hostname),
        onProtectedResponseFailure,
        protectedResponseBudget
      )
    );
  };
  const commonOptions = {
    host: target.hostname,
    port: target.port,
    path,
    method: req.method,
    headers: fwdHeaders,
    agent: false as const
  };
  const upstream = secure
    ? httpsRequest(
        {
          ...commonOptions,
          ...(isIP(target.hostname) ? {} : { servername: target.hostname }),
          ...(target.upstreamCA ? { ca: target.upstreamCA } : {})
        },
        onResponse
      )
    : httpRequest(commonOptions, onResponse);
  trackUpstream(upstream);

  upstream.on('error', () => {
    if (receivedResponse) return;
    logger.error('tls_terminate_upstream_failed');
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

function startInnerServer(
  inner: HttpServer,
  onReady: (handle: TerminateHandle) => void,
  onError: () => void,
  beforeClose: () => void,
  drain: () => Promise<void>
): void {
  const sockPath = innerSocketPath();
  let loop: NodeSocket | undefined;
  let closing = false;
  let finished = false;
  let ready = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const finish = (): void => {
    if (finished) return;
    finished = true;
    unlink(sockPath, () => {
      void drain().finally(resolveClosed);
    });
  };
  const cleanup = (): void => {
    if (closing) return;
    closing = true;
    beforeClose();
    loop?.destroy();
    try {
      inner.close(() => finish());
      inner.closeAllConnections?.();
      finish();
    } catch {
      finish();
    }
  };
  const fail = (code: string): void => {
    logger.error(code);
    cleanup();
    if (!ready) onError();
  };

  inner.once('error', () => fail('tls_terminate_inner_listen_failed'));
  inner.listen(sockPath, () => {
    const connectedLoop = connect({ path: sockPath });
    loop = connectedLoop;
    connectedLoop.once('error', () => fail('tls_terminate_loopback_failed'));
    connectedLoop.once('connect', () => {
      ready = true;
      onReady({ loop: connectedLoop, close: cleanup, closed });
    });
    connectedLoop.once('close', cleanup);
  });
  inner.unref();
}

function taskTracker(tasks: Set<Promise<void>>): (task: Promise<void>) => void {
  return (task) => {
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task)
    );
  };
}

function upstreamTracker(upstreams: Set<ClientRequest>): (upstream: ClientRequest) => void {
  return (upstream) => {
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
  };
}

function responseTracker(responses: Set<IncomingMessage>): (response: IncomingMessage) => void {
  return (response) => {
    responses.add(response);
    response.once('close', () => responses.delete(response));
  };
}

// Read up to `cap` bytes of a request body into one buffer. Content-Length already bounds it to ≤ cap;
// the guard is defence in depth against a lying length.
async function readBounded(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > cap) throw new Error('protected_request_body_too_large');
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
function parseHeaderBlock(block: string, original: Headers, originalPath: string): { headers: Headers; path: string } {
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
  const requestTarget = lines[0]?.split(' ')[1];
  return {
    headers: Object.keys(out).length > 0 ? out : original,
    path: requestTarget?.startsWith('/') || requestTarget === '*' ? requestTarget : originalPath
  };
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
