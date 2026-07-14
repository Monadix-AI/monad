// Call-time security primitives for tool implementations. Tool arguments are
// attacker-controllable (prompt injection), so fs and network tools validate them at
// invocation — declaring a sandbox scope in the schema is not enforcement.
// See docs/engineering/security-guidelines.md §4.

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
 * Parse any textual IPv6 literal into its 8 16-bit groups, so classification is done on
 * normalized bytes rather than fragile string prefixes. Handles `::` zero-compression, the
 * fully-expanded form (`0:0:0:0:0:0:0:1`), and an embedded trailing IPv4 (`::ffff:127.0.0.1`,
 * `::127.0.0.1`). Returns null for anything that isn't a parseable IPv6 literal.
 */
function ipv6Groups(addr: string): number[] | null {
  const s = (addr.split('%', 1)[0] ?? addr).replace(/^\[|\]$/g, '');
  if (!s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const segs = part.split(':');
    const out: number[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i] ?? '';
      if (seg.includes('.')) {
        if (i !== segs.length - 1) return null; // embedded IPv4 only valid as the last group
        const o = seg.split('.').map(Number);
        if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push(((o[0] as number) << 8) | (o[1] as number), ((o[2] as number) << 8) | (o[3] as number));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
        out.push(Number.parseInt(seg, 16));
      }
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array<number>(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/**
 * True when an IP literal must never be fetched: loopback, private, link-local
 * (incl. 169.254.169.254 cloud-metadata), unique-local, or unspecified.
 * Re-run after DNS resolution too — a public hostname can resolve to a private IP
 * (DNS-rebinding SSRF).
 */
export function isBlockedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase();

  if (addr.includes(':')) {
    const g = ipv6Groups(addr);
    if (!g) return false; // not a parseable IPv6 literal — hostname screening handles it
    // IPv4-mapped (::ffff:v4) and IPv4-compatible (::v4, incl. :: and ::1) — classify by the
    // embedded v4. Covers every textual form (compressed or fully expanded) via the parsed groups.
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
      const hi = g[6] as number;
      const lo = g[7] as number;
      return isBlockedIp(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    if (((g[0] as number) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if (((g[0] as number) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
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
