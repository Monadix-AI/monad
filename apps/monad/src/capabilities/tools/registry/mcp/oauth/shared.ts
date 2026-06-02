// Primitives shared across the OAuth modules: the injectable fetch type, the error class the whole
// flow throws, and the persisted-token shape. Kept separate so every sibling can import these
// without a cycle.

export type FetchImpl = typeof fetch;

export class McpOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpOAuthError';
  }
}

/** Persisted OAuth state for one server (structurally matches @monad/home's McpOAuthToken). The
 *  daemon owns the live token lifecycle (via the MCP SDK); this is just the on-disk shape it
 *  reads/writes and that the device-grant flow returns. */
export interface StoredOAuth {
  clientId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpoint: string;
  resource: string;
}
