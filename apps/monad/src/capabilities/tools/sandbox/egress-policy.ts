// Egress allowlist for confined children. A sandbox runs with net:'none' and is only allowed to
// reach a local filtering proxy; the proxy consults this policy to decide which destinations the
// child's curl/pip/npm/git may actually reach. Centralizing the decision here means the proxy and
// net_fetch share one notion of "allowed", layered on the existing SSRF guards (isBlockedIp).

import { isBlockedIp } from '../security.ts';

export interface EgressPolicy {
  /**
   * Allowed destination domains. A host matches if it equals a domain or is a subdomain of it
   * (`files.pythonhosted.org` matches domain `pythonhosted.org`). `'*'` allows any host that still
   * passes the SSRF checks. An empty list denies everything.
   */
  allowedDomains: string[];
}

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** Lowercase, strip IPv6 brackets and the FQDN root dot so matching/blocklists can't be bypassed. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

/** True when `host` is `domain` or a subdomain of it. */
export function domainMatches(host: string, domain: string): boolean {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Decide whether a confined child may reach `host`. Order matters: SSRF/loopback denials are
 * absolute and apply even under `'*'` — the allowlist can widen public access but never re-open a
 * private/loopback target.
 */
export function isEgressAllowed(host: string, policy: EgressPolicy): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return false;
  const isIpLiteral = IPV4.test(h) || h.includes(':');
  if (isIpLiteral && isBlockedIp(h)) return false;
  if (policy.allowedDomains.includes('*')) return true;
  return policy.allowedDomains.some((d) => domainMatches(h, d));
}
