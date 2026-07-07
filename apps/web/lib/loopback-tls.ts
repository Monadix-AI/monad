function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function loopbackTlsOptions(url: string): { tls?: { rejectUnauthorized: boolean } } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && isLoopbackHostname(parsed.hostname)) {
      return { tls: { rejectUnauthorized: false } };
    }
  } catch {
    return {};
  }
  return {};
}
