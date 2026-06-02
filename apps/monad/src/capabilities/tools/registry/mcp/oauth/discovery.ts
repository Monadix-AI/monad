// Server/resource discovery for the device-grant flow: Protected Resource Metadata (RFC 9728),
// Authorization Server Metadata (RFC 8414), and Resource Indicators canonicalization (RFC 8707).
// The interactive flow's discovery + DCR run on the MCP SDK; these helpers remain for the device
// flow (RFC 8628), which the SDK does not implement.

import { type FetchImpl, McpOAuthError } from './shared.ts';

export interface AuthServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** RFC 8628 device authorization endpoint (for headless/remote daemons). */
  deviceAuthorizationEndpoint?: string;
}

/**
 * Canonical resource URI: no fragment, no trailing slash. The `resource` value is bound
 * into the token so it can't be replayed against another server (RFC 8707).
 * Throws on a scheme-less input — an invalid resource identifier.
 */
export function canonicalResourceUri(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  let path = u.pathname;
  if (path.endsWith('/')) path = path.slice(0, -1);
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/** Default Protected Resource Metadata URL when no WWW-Authenticate header is present. */
export function defaultResourceMetadataUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `${u.protocol}//${u.host}/.well-known/oauth-protected-resource`;
}

export async function discoverProtectedResource(
  resourceMetadataUrl: string,
  fetchImpl: FetchImpl = fetch
): Promise<{ authorizationServers: string[]; resource?: string }> {
  const res = await fetchImpl(resourceMetadataUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new McpOAuthError(`protected resource metadata fetch failed: ${res.status}`);
  const body = (await res.json()) as { authorization_servers?: string[]; resource?: string };
  const authorizationServers = body.authorization_servers ?? [];
  if (authorizationServers.length === 0) throw new McpOAuthError('no authorization_servers in resource metadata');
  return { authorizationServers, resource: body.resource };
}

/** RFC 8414 discovery; tries oauth-authorization-server well-known then OIDC openid-configuration. */
export async function discoverAuthServer(issuer: string, fetchImpl: FetchImpl = fetch): Promise<AuthServerMetadata> {
  const base = issuer.replace(/\/$/, '');
  const candidates = [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`];
  for (const url of candidates) {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } }).catch(() => null);
    if (!res?.ok) continue;
    const m = (await res.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      device_authorization_endpoint?: string;
    };
    if (m.authorization_endpoint && m.token_endpoint) {
      return {
        authorizationEndpoint: m.authorization_endpoint,
        tokenEndpoint: m.token_endpoint,
        registrationEndpoint: m.registration_endpoint,
        deviceAuthorizationEndpoint: m.device_authorization_endpoint
      };
    }
  }
  throw new McpOAuthError(`could not discover authorization server metadata for ${issuer}`);
}
