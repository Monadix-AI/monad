import { getHealthResponseSchema, MONAD_VERSION } from '@monad/protocol';

export const CLIENT_VERSION: string = MONAD_VERSION;

export interface VersionCheckResult {
  compatible: boolean;
  daemonVersion: string;
  clientVersion: string;
  /** Human-readable mismatch reason; absent when compatible. */
  reason?: string;
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 0.x.y (pre-release): major AND minor must match.
 * 1.x.y+ (stable): only major must match.
 */
export function isVersionCompatible(daemonVersion: string, clientVersion: string): VersionCheckResult {
  const dv = parseSemver(daemonVersion);
  const cv = parseSemver(clientVersion);

  if (!dv || !cv) {
    return {
      compatible: false,
      daemonVersion,
      clientVersion,
      reason: 'unparseable version string'
    };
  }

  const [dMaj, dMin] = dv;
  const [cMaj, cMin] = cv;

  const compatible = dMaj === 0 ? dMaj === cMaj && dMin === cMin : dMaj === cMaj;

  return {
    compatible,
    daemonVersion,
    clientVersion,
    reason: compatible ? undefined : `daemon ${daemonVersion} is incompatible with client ${clientVersion}`
  };
}

export function isLoopbackHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '::1' ||
        parsed.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

export async function checkDaemonVersion(baseUrl: string, token?: string): Promise<VersionCheckResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/health`;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  const fetchOpts: RequestInit = { headers, signal: AbortSignal.timeout(5000) };
  if (isLoopbackHttpsUrl(url)) (fetchOpts as BunFetchRequestInit).tls = { rejectUnauthorized: false };

  let daemonVersion: string;
  try {
    const res = await fetch(url, fetchOpts);
    if (!res.ok) {
      return {
        compatible: false,
        daemonVersion: 'unknown',
        clientVersion: CLIENT_VERSION,
        reason: `health check returned ${res.status}`
      };
    }
    const body = getHealthResponseSchema.parse(await res.json());
    if (typeof body.version !== 'string') {
      return {
        compatible: false,
        daemonVersion: 'unknown',
        clientVersion: CLIENT_VERSION,
        reason: 'health response missing version field'
      };
    }
    daemonVersion = body.version;
  } catch (err) {
    return {
      compatible: false,
      daemonVersion: 'unknown',
      clientVersion: CLIENT_VERSION,
      reason: err instanceof Error ? err.message : 'health check failed'
    };
  }

  return isVersionCompatible(daemonVersion, CLIENT_VERSION);
}
