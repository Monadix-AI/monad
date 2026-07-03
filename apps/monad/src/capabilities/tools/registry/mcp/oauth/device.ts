// Device Authorization Grant (RFC 8628) — for headless/remote daemons where a loopback browser
// redirect is unreachable: show a short user_code + verification URL, then poll the token endpoint
// until the operator authorizes on any device.

import { type FetchImpl, McpOAuthError } from './shared.ts';
import { type OAuthTokens, parseTokenResponse } from './tokens.ts';

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number; // seconds
  expiresAt: number; // epoch ms
}

export async function startDeviceAuthorization(
  params: { deviceAuthorizationEndpoint: string; clientId: string; resource: string; scopes?: string[] },
  fetchImpl: FetchImpl = fetch,
  now: number = Date.now()
): Promise<DeviceAuthorization> {
  const form: Record<string, string> = { client_id: params.clientId, resource: params.resource };
  if (params.scopes?.length) form.scope = params.scopes.join(' ');
  const res = await fetchImpl(params.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString()
  });
  if (!res.ok) throw new McpOAuthError(`device authorization request failed: ${res.status}`);
  const b = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!b.device_code || !b.user_code || !b.verification_uri) {
    throw new McpOAuthError('incomplete device authorization response');
  }
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: b.verification_uri,
    verificationUriComplete: b.verification_uri_complete,
    interval: typeof b.interval === 'number' ? b.interval : 5,
    expiresAt: now + (typeof b.expires_in === 'number' ? b.expires_in : 900) * 1000
  };
}

/**
 * Poll until the user authorizes or the device code expires. Handles RFC 8628
 * `authorization_pending` (keep waiting) and `slow_down` (back off) signals.
 * `sleep`/`now` are injectable so the loop is unit-testable without real delays.
 */
export async function pollDeviceToken(
  params: {
    tokenEndpoint: string;
    deviceCode: string;
    clientId: string;
    resource: string;
    interval: number;
    expiresAt: number;
  },
  fetchImpl: FetchImpl = fetch,
  opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number }
): Promise<OAuthTokens> {
  const sleep = opts?.sleep ?? Bun.sleep;
  const now = opts?.now ?? (() => Date.now());
  let interval = params.interval;

  for (;;) {
    if (now() >= params.expiresAt) throw new McpOAuthError('device authorization expired before the user approved');
    await sleep(interval * 1000);
    const res = await fetchImpl(params.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT,
        device_code: params.deviceCode,
        client_id: params.clientId,
        resource: params.resource
      }).toString()
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok) return parseTokenResponse(body, now());
    const error = typeof body.error === 'string' ? body.error : `http_${res.status}`;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5; // RFC 8628 §3.5 — increase by at least 5s on slow_down
      continue;
    }
    throw new McpOAuthError(`device token request denied: ${error}`); // access_denied, expired_token, …
  }
}
