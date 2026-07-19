export function schemeTargetUrl(
  currentUrl: string,
  settings: { enabled: boolean; host: string; port: number }
): string {
  const target = new URL(currentUrl);
  target.protocol = settings.enabled ? 'https:' : 'http:';
  target.hostname = settings.host === '0.0.0.0' ? target.hostname : settings.host;
  target.port = String(settings.port);
  return target.toString();
}

export function isExpectedSchemeDisconnect(enabled: boolean, error: unknown): boolean {
  if (enabled) return false;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    if (typeof error.status !== 'number' || error.status < 100) return true;
    if ('raw' in error && typeof error.raw === 'object' && error.raw !== null && 'name' in error.raw) {
      return error.raw.name === 'TypeError';
    }
    return false;
  }
  return true;
}
