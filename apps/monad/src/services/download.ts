export interface DownloadProgress {
  loadedBytes: number;
  totalBytes?: number;
  percent?: number;
}

type DownloadHeaders = Headers | Record<string, string> | Array<[string, string]>;
export type DownloadFetch = (
  url: string,
  init?: {
    headers?: DownloadHeaders;
    signal?: AbortSignal;
  }
) => Promise<Response>;

export interface DownloadBytesOptions {
  fetch?: DownloadFetch;
  headers?: DownloadHeaders;
  accept?: string;
  allowedContentTypes?: string[];
  maxBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadBytesResult {
  bytes: Uint8Array;
  contentType?: string;
}

class DownloadError extends Error {}

function contentTypeMatches(contentType: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!contentType) return false;
  const [mediaType] = contentType.toLowerCase().split(';', 1);
  if (!mediaType) return false;
  return allowed.some((candidate) => {
    const normalized = candidate.toLowerCase();
    if (normalized.endsWith('/*')) return mediaType.startsWith(normalized.slice(0, -1));
    return mediaType === normalized;
  });
}

function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (signal && timeoutMs !== undefined) return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  if (timeoutMs !== undefined) return AbortSignal.timeout(timeoutMs);
  return signal;
}

function totalBytesFrom(headers: Headers): number | undefined {
  const value = headers.get('content-length');
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function mergeHeaders(headers: DownloadHeaders | undefined, accept: string | undefined): Headers {
  const merged = new Headers(headers);
  if (accept && !merged.has('accept')) merged.set('accept', accept);
  return merged;
}

async function readWithProgress(
  url: string,
  body: ReadableStream<Uint8Array>,
  totalBytes: number | undefined,
  maxBytes: number | undefined,
  onProgress: ((progress: DownloadProgress) => void) | undefined
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (maxBytes !== undefined && loadedBytes + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new DownloadError(`download ${url} exceeds ${maxBytes} bytes`);
      }
      loadedBytes += value.byteLength;
      chunks.push(value);
      onProgress?.({
        loadedBytes,
        totalBytes,
        percent: totalBytes === undefined || totalBytes === 0 ? undefined : (loadedBytes / totalBytes) * 100
      });
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadBytes(url: string, options: DownloadBytesOptions = {}): Promise<DownloadBytesResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    headers: mergeHeaders(options.headers, options.accept),
    signal: signalWithTimeout(options.signal, options.timeoutMs)
  });
  if (!response.ok) throw new DownloadError(`download ${url} failed: HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') ?? undefined;
  if (!contentTypeMatches(contentType, options.allowedContentTypes ?? [])) {
    throw new DownloadError(`download ${url} returned unexpected content type: ${contentType ?? 'missing'}`);
  }
  const totalBytes = totalBytesFrom(response.headers);
  if (options.maxBytes !== undefined && totalBytes !== undefined && totalBytes > options.maxBytes) {
    throw new DownloadError(`download ${url} exceeds ${options.maxBytes} bytes`);
  }
  if (!response.body) throw new DownloadError(`download ${url} returned an empty response body`);

  return {
    bytes: await readWithProgress(url, response.body, totalBytes, options.maxBytes, options.onProgress),
    contentType
  };
}
