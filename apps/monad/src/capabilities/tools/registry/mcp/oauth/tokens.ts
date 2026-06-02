// Token-response parsing for the device-grant poller. The interactive code-exchange and refresh
// run on the official MCP SDK (see apps/monad/src/services/mcp-oauth.ts); only the device flow
// (RFC 8628), which the SDK does not implement, still parses token responses here.

import { McpOAuthError } from './shared.ts';

export interface OAuthTokens {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms, derived from expires_in at receipt
  scope?: string;
}

export function parseTokenResponse(body: Record<string, unknown>, receivedAt: number): OAuthTokens {
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string') throw new McpOAuthError('token response missing access_token');
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined;
  return {
    accessToken,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: expiresIn ? receivedAt + expiresIn * 1000 : undefined,
    scope: typeof body.scope === 'string' ? body.scope : undefined
  };
}
