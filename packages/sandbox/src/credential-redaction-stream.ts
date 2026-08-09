import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http';

import { Transform, type TransformCallback } from 'node:stream';

const MAX_RESPONSE_REWRITE_BYTES = 1024 * 1024;
const MAX_RESPONSE_HEADER_REWRITE_BYTES = 64 * 1024;
const PROTECTED_RESPONSE_RESERVATION_BYTES = MAX_RESPONSE_REWRITE_BYTES * 2 + MAX_RESPONSE_HEADER_REWRITE_BYTES;

export interface CredentialRedaction {
  readonly secret: string;
  readonly sentinel: string;
}

export type ResponseRedactions = (host: string) => readonly CredentialRedaction[];
export type ProtectedResponseFailureCode =
  | 'protected_response_budget_exceeded'
  | 'protected_response_compressed'
  | 'protected_response_header_name_unsafe'
  | 'protected_response_headers_too_large'
  | 'protected_response_invalid_text'
  | 'protected_response_output_too_large'
  | 'protected_response_read_failed'
  | 'protected_response_too_large'
  | 'protected_response_unsupported_content_type';
export type ProtectedResponseFailure = (code: ProtectedResponseFailureCode) => void;
export interface ProtectedResponseWriter extends NodeJS.WritableStream {
  readonly headersSent: boolean;
  destroy(error?: Error): unknown;
  writeHead(statusCode: number, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]): unknown;
  writeHead(statusCode: number, statusMessage?: string, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]): unknown;
}

interface CredentialRedactionOptions {
  readonly maxOutputBytes?: number;
}

interface ByteRedaction {
  readonly secret: Buffer;
  readonly sentinel: Buffer;
}

export class CredentialRedactionOutputLimitError extends Error {
  constructor() {
    super('credential_redaction_output_too_large');
  }
}

export class ProtectedResponseBudget {
  private reserved = 0;
  private closed = false;

  constructor(private readonly maxBytes = PROTECTED_RESPONSE_RESERVATION_BYTES) {}

  get reservedBytes(): number {
    return this.reserved;
  }

  reserve(bytes: number): (() => void) | undefined {
    if (this.closed || bytes < 0 || this.reserved + bytes > this.maxBytes) return undefined;
    this.reserved += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved -= bytes;
    };
  }

  close(): void {
    this.closed = true;
  }
}

export class CredentialRedactionStream extends Transform {
  private readonly redactions: readonly ByteRedaction[];
  private readonly overlap: number;
  private readonly maxOutputBytes: number;
  private emittedBytes = 0;
  private pending: Buffer = Buffer.alloc(0);

  constructor(redactions: readonly CredentialRedaction[], options: CredentialRedactionOptions = {}) {
    super();
    this.redactions = compileRedactions(redactions);
    this.overlap = Math.max(0, ...this.redactions.map(({ secret }) => secret.length - 1));
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_RESPONSE_REWRITE_BYTES;
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const combined = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
      const emitBefore = Math.max(0, combined.length - this.overlap);
      const rewritten = rewriteUntil(combined, this.redactions, emitBefore, this.maxOutputBytes - this.emittedBytes);
      this.pending = combined.subarray(rewritten.consumed);
      this.emittedBytes += rewritten.output.length;
      if (rewritten.output.length > 0) this.push(rewritten.output);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      const rewritten = rewriteUntil(
        this.pending,
        this.redactions,
        this.pending.length,
        this.maxOutputBytes - this.emittedBytes
      );
      this.emittedBytes += rewritten.output.length;
      if (rewritten.output.length > 0) this.push(rewritten.output);
      this.pending = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

export function redactCredentialBytes(
  input: Buffer,
  redactions: readonly CredentialRedaction[],
  options: CredentialRedactionOptions = {}
): Buffer {
  return rewriteUntil(
    input,
    compileRedactions(redactions),
    input.length,
    options.maxOutputBytes ?? Number.MAX_SAFE_INTEGER
  ).output;
}

export async function forwardProtectedCredentialResponse(
  method: string | undefined,
  upstream: IncomingMessage,
  response: ProtectedResponseWriter,
  redactions: readonly CredentialRedaction[],
  onFailure: ProtectedResponseFailure | undefined,
  budget = new ProtectedResponseBudget()
): Promise<void> {
  const release = budget.reserve(PROTECTED_RESPONSE_RESERVATION_BYTES);
  if (!release) {
    upstream.destroy();
    failProtectedResponse(response, 'protected_response_budget_exceeded', onFailure);
    return;
  }

  try {
    let headers: Headers;
    try {
      headers = redactResponseHeaders(upstream.headers, redactions);
    } catch (error) {
      upstream.destroy();
      const code = error instanceof ProtectedResponseError ? error.code : ('protected_response_read_failed' as const);
      failProtectedResponse(response, code, onFailure);
      return;
    }

    const encoding = String(upstream.headers['content-encoding'] ?? '')
      .trim()
      .toLowerCase();
    if (encoding && encoding !== 'identity') {
      upstream.destroy();
      failProtectedResponse(response, 'protected_response_compressed', onFailure);
      return;
    }

    const status = upstream.statusCode ?? 502;
    if (method === 'HEAD' || status < 200 || status === 204 || status === 304) {
      response.writeHead(status, headers);
      response.end();
      upstream.resume();
      return;
    }

    const contentType = String(upstream.headers['content-type'] ?? '');
    if (contentType && !isCredentialTextualContentType(contentType)) {
      upstream.destroy();
      failProtectedResponse(response, 'protected_response_unsupported_content_type', onFailure);
      return;
    }

    let body: Buffer;
    try {
      body = await readResponseBody(upstream, MAX_RESPONSE_REWRITE_BYTES);
    } catch (error) {
      const code = error instanceof ProtectedResponseError ? error.code : 'protected_response_read_failed';
      failProtectedResponse(response, code, onFailure);
      return;
    }

    if (body.length > 0 && !contentType) {
      failProtectedResponse(response, 'protected_response_unsupported_content_type', onFailure);
      return;
    }
    if (decodeCredentialUtf8(body) === undefined) {
      failProtectedResponse(response, 'protected_response_invalid_text', onFailure);
      return;
    }

    let rewrittenBody: Buffer;
    try {
      rewrittenBody = redactCredentialBytes(body, redactions, { maxOutputBytes: MAX_RESPONSE_REWRITE_BYTES });
    } catch (error) {
      const code =
        error instanceof CredentialRedactionOutputLimitError
          ? 'protected_response_output_too_large'
          : 'protected_response_read_failed';
      failProtectedResponse(response, code, onFailure);
      return;
    }
    delete headers['transfer-encoding'];
    delete headers['content-encoding'];
    headers['content-length'] = String(rewrittenBody.length);
    response.writeHead(status, headers);
    response.end(rewrittenBody);
  } finally {
    release();
  }
}

export function isCredentialTextualContentType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType.endsWith('+json') ||
    mediaType === 'application/xml' ||
    mediaType.endsWith('+xml') ||
    mediaType === 'application/javascript' ||
    mediaType === 'application/x-javascript' ||
    mediaType === 'application/x-www-form-urlencoded' ||
    mediaType === 'application/graphql' ||
    mediaType === 'application/yaml' ||
    mediaType === 'application/x-yaml'
  );
}

export function decodeCredentialUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function compileRedactions(redactions: readonly CredentialRedaction[]): readonly ByteRedaction[] {
  return redactions
    .filter(({ secret }) => secret.length > 0)
    .map(({ secret, sentinel }) => ({
      secret: Buffer.from(secret, 'utf8'),
      sentinel: Buffer.from(sentinel, 'utf8')
    }))
    .sort((a, b) => b.secret.length - a.secret.length);
}

function rewriteUntil(
  input: Buffer,
  redactions: readonly ByteRedaction[],
  emitBefore: number,
  maxOutputBytes: number
): { output: Buffer; consumed: number } {
  let cursor = 0;
  let outputLength = 0;

  while (cursor < emitBefore) {
    const match = findRedaction(input, cursor, redactions);
    if (!match) {
      cursor++;
      outputLength++;
      if (outputLength > maxOutputBytes) throw new CredentialRedactionOutputLimitError();
      continue;
    }
    cursor += match.secret.length;
    outputLength += match.sentinel.length;
    if (outputLength > maxOutputBytes) throw new CredentialRedactionOutputLimitError();
  }

  const output = Buffer.allocUnsafe(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;
  while (inputOffset < cursor) {
    const match = findRedaction(input, inputOffset, redactions);
    if (match) {
      match.sentinel.copy(output, outputOffset);
      inputOffset += match.secret.length;
      outputOffset += match.sentinel.length;
      continue;
    }
    input.copy(output, outputOffset, inputOffset, inputOffset + 1);
    outputOffset++;
    inputOffset++;
  }
  return { output, consumed: cursor };
}

function findRedaction(input: Buffer, cursor: number, redactions: readonly ByteRedaction[]): ByteRedaction | undefined {
  return redactions.find(
    ({ secret }) =>
      cursor + secret.length <= input.length &&
      input.compare(secret, 0, secret.length, cursor, cursor + secret.length) === 0
  );
}

class ProtectedResponseError extends Error {
  constructor(readonly code: ProtectedResponseFailureCode) {
    super(code);
  }
}

async function readResponseBody(upstream: IncomingMessage, cap: number): Promise<Buffer> {
  const body = Buffer.allocUnsafe(cap);
  let size = 0;
  try {
    for await (const chunk of upstream) {
      const bytes = Buffer.from(chunk);
      if (size + bytes.length > cap) {
        upstream.destroy();
        throw new ProtectedResponseError('protected_response_too_large');
      }
      bytes.copy(body, size);
      size += bytes.length;
    }
  } catch (error) {
    if (error instanceof ProtectedResponseError) throw error;
    throw new ProtectedResponseError('protected_response_read_failed');
  }
  return body.subarray(0, size);
}

type Headers = IncomingMessage['headers'];

function redactResponseHeaders(headers: Headers, redactions: readonly CredentialRedaction[]): Headers {
  const output: Headers = {};
  let remainingBytes = MAX_RESPONSE_HEADER_REWRITE_BYTES;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const normalizedName = name.toLowerCase();
    if (
      redactions.some(({ secret }) => secret.length > 0 && normalizedName.includes(secret.toLocaleLowerCase('en-US')))
    ) {
      throw new ProtectedResponseError('protected_response_header_name_unsafe');
    }
    if (Array.isArray(value)) {
      output[name] = value.map((entry) => {
        const rewritten = redactHeaderValue(entry, redactions, remainingBytes);
        remainingBytes -= Buffer.byteLength(rewritten);
        return rewritten;
      });
      continue;
    }
    const rewritten = redactHeaderValue(String(value), redactions, remainingBytes);
    remainingBytes -= Buffer.byteLength(rewritten);
    output[name] = rewritten;
  }
  return output;
}

function redactHeaderValue(value: string, redactions: readonly CredentialRedaction[], maxOutputBytes: number): string {
  try {
    return redactCredentialBytes(Buffer.from(value, 'utf8'), redactions, { maxOutputBytes }).toString('utf8');
  } catch (error) {
    if (error instanceof CredentialRedactionOutputLimitError) {
      throw new ProtectedResponseError('protected_response_headers_too_large');
    }
    throw error;
  }
}

function failProtectedResponse(
  response: ProtectedResponseWriter,
  code: ProtectedResponseFailureCode,
  onFailure: ProtectedResponseFailure | undefined
): void {
  onFailure?.(code);
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, { 'Content-Type': 'text/plain', 'Content-Length': '11' });
  response.end('Bad Gateway');
}
