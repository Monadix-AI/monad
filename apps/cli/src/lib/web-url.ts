export function resolveUpWebUrl(opts: { daemonUrl: string; nodeEnv?: string; webPort?: string }): string {
  const daemonUrl = opts.daemonUrl.replace(/\/$/, '');
  if (opts.nodeEnv !== 'production' && opts.webPort) {
    const scheme = new URL(daemonUrl).protocol === 'http:' ? 'http' : 'https';
    return `${scheme}://localhost:${opts.webPort}`;
  }
  return daemonUrl;
}
