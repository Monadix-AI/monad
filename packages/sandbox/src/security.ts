// Call-time security primitives for tool implementations. Tool arguments are
// attacker-controllable (prompt injection), so fs and network tools validate them at
// invocation — declaring a sandbox scope in the schema is not enforcement.
// See docs/security-guidelines.md §4.

import { isAbsolute, resolve, sep } from 'node:path';

/** Thrown when a tool argument violates a sandbox/SSRF constraint. */
export class ToolSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSecurityError';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost']);

/**
 * True when an IP literal must never be fetched: loopback, private, link-local
 * (incl. 169.254.169.254 cloud-metadata), unique-local, or unspecified.
 * Re-run after DNS resolution too — a public hostname can resolve to a private IP
 * (DNS-rebinding SSRF).
 */
export function isBlockedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — classify by the embedded v4 address.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedIp(mapped[1]);

  if (addr.includes(':')) {
    if (addr === '::1' || addr === '::') return true; // loopback / unspecified
    if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // fc00::/7 unique-local
    return false;
  }

  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  return false;
}

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Validate a URL before an outbound fetch. Rejects non-http(s) schemes and any host
 * that is loopback/private/link-local by literal IP or obvious name. NOTE: cannot
 * catch a public name resolving to a private IP — callers must also DNS-resolve and
 * re-check via isBlockedIp (net.ts does this).
 */
export function assertUrlAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolSecurityError(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolSecurityError(`blocked URL scheme: ${url.protocol} (only http/https allowed)`);
  }
  // Some runtimes keep the brackets on IPv6 literals (http://[::1]/). A trailing dot is the
  // FQDN root label (`localhost.` ≡ `localhost`), so strip it or the blocklist below is bypassed.
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new ToolSecurityError(`blocked host: ${host}`);
  }
  const isIpLiteral = IPV4.test(host) || host.includes(':');
  if (isIpLiteral && isBlockedIp(host)) {
    throw new ToolSecurityError(`blocked host (private/loopback address): ${host}`);
  }
  return url;
}

/**
 * Resolve `requested` and assert it lies within one of the sandbox `roots`.
 * Relative paths resolve against the primary root. `roots === undefined` = unrestricted.
 *
 * Defeats `..` traversal lexically. Callers opening an EXISTING file must also realpath()
 * and re-check — a symlink inside the sandbox can point out of it (fs.ts does this).
 */
export function assertPathWithinRoots(requested: string, roots: string[] | undefined): string {
  if (!requested) throw new ToolSecurityError('empty path');
  const base = roots?.[0] ?? process.cwd();
  const resolved = isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
  if (!roots) return resolved; // unrestricted

  for (const root of roots) {
    const r = resolve(root);
    if (resolved === r || resolved.startsWith(r + sep)) return resolved;
  }
  throw new ToolSecurityError(
    `path escapes sandbox: ${requested} — the agent's workspace is confined to ${roots.join(', ')}. Tell the user you cannot access this path and ask them to move the file into the workspace or expand the scope.`
  );
}
