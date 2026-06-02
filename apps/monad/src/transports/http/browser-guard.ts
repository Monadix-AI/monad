// Browser-facing request guard for the daemon's HTTP + WebSocket surface.
//
// The daemon listens on loopback (and, opt-in, on 0.0.0.0). A loopback peer is NOT
// a principal — any web page the user visits can reach `http://127.0.0.1:<port>` and
// `ws://127.0.0.1:<port>`. Two browser-only attacks follow, and this guard closes
// both before any handler (or WS upgrade) runs:
//
//   • CSRF / CSWSH — a cross-site page issues requests/opens sockets to the daemon.
//     Browsers attach an `Origin` header to these; native clients (the Bun WS client,
//     the CLI's Eden treaty, TUI, desktop) never do. So a present, non-loopback
//     Origin is the tell.
//   • DNS rebinding — the attacker rebinds their own domain to 127.0.0.1, after which
//     requests look same-origin (Origin matches Host) and the Origin check alone
//     passes. The defense is a `Host` allowlist: the rebound `Host: attacker.com`
//     is not loopback, so it is rejected.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True when a request arrived over the Unix socket (no peer IP) or from a loopback address.
 * Gate endpoints that must never serve a remote peer — even an authenticated one — with this
 * (e.g. one that drives the host desktop), independently of the remote-access token guard.
 */
export function isLoopbackPeer(address: string | null | undefined): boolean {
  return !address || LOOPBACK_PEERS.has(address);
}

/** Extract the hostname from an `Origin` (scheme://host:port) or `Host` (host:port). */
function hostnameOf(value: string | null): string | null {
  if (!value) return null;
  const authority = value.replace(/^[a-z]+:\/\//i, '');
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return null;
  }
}

export interface BrowserGuardOptions {
  /** True when remote access is enabled (daemon bound to 0.0.0.0, bearer-token gated). */
  remoteEnabled: boolean;
}

/**
 * Decide whether a browser-reachable request may proceed. Native (non-browser)
 * clients send no `Origin`, so they are unaffected; this only constrains browsers.
 */
export function isBrowserRequestAllowed(request: Request, { remoteEnabled }: BrowserGuardOptions): boolean {
  const originHeader = request.headers.get('origin');
  const originHost = originHeader ? hostnameOf(originHeader) : null;
  const hostName = hostnameOf(request.headers.get('host'));

  if (!remoteEnabled) {
    // Loopback-only daemon: the only legitimate callers are local. Reject any Host
    // that is not loopback (DNS rebinding) and any Origin that is not loopback (CSRF).
    if (hostName !== null && !LOOPBACK_HOSTS.has(hostName)) return false;
    if (originHeader && (originHost === null || !LOOPBACK_HOSTS.has(originHost))) return false;
    return true;
  }

  // Remote access enabled: the bearer token guards non-loopback peers, and the bound
  // hostname can be anything, so we can't allowlist Host. Still reject an Origin that
  // is neither loopback nor same-origin as the listener (the UI the daemon serves).
  if (originHeader) {
    if (originHost === null) return false;
    if (!LOOPBACK_HOSTS.has(originHost) && originHost !== hostName) return false;
  }
  return true;
}
