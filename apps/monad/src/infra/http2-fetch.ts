type BunFetchProtocol = 'http2' | 'h2' | 'http1.1' | 'h1' | 'http3' | 'h3';
type BunRequestInit = RequestInit & { protocol?: BunFetchProtocol };
type FetchImpl = typeof globalThis.fetch;

let http2FetchSingleton: FetchImpl | null = null;

export function getHttp2Fetch(): FetchImpl {
  http2FetchSingleton ??= createHttp2Fetch(globalThis.fetch);
  return http2FetchSingleton;
}

export function createHttp2Fetch(fetchImpl: FetchImpl): FetchImpl {
  return ((input: Parameters<FetchImpl>[0], init?: Parameters<FetchImpl>[1]) => {
    const requestInit = init as BunRequestInit | undefined;
    if (requestInit?.protocol || !isHttpsRequest(input)) return fetchImpl(input, init);
    return fetchImpl(input, { ...requestInit, protocol: 'http2' } as RequestInit);
  }) as FetchImpl;
}

function isHttpsRequest(input: Parameters<FetchImpl>[0]): boolean {
  if (typeof input === 'string') return input.startsWith('https:');
  if (input instanceof URL) return input.protocol === 'https:';
  return input.url.startsWith('https:');
}
