// Auto-register this daemon as a native Monadix provider using the `monad monadix login` identity.
// Cabinet's POST /providers/register is Clerk-authenticated, so the stored MCP OAuth access token
// (auth.json mcpOAuth["monadix"]) authorizes it — one login serves both consume and provide. Native
// framework 'monad' routes dispatch over the realtime transport (no gateway/public URL).

import { z } from 'zod';

export const MONADIX_DEFAULT_API_BASE = 'https://api.monadix.ai';
const realtimeConfigSchema = z.object({ supabaseUrl: z.string(), supabaseAnonKey: z.string() });
const registerProviderResponseSchema = z.object({ provider: z.object({ id: z.string() }) });

/** Read a non-OK response body and throw a uniform error. Shared by the Monadix HTTP calls. */
export async function monadixHttpError(res: Response, what: string): Promise<never> {
  const body = await res.text().catch(() => '');
  throw new Error(`${what}: HTTP ${res.status} ${body.slice(0, 256)}`);
}

export interface RealtimeConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

/** Fetch the network's public realtime bootstrap (Supabase URL + anon key) from `GET /realtime/config`.
 *  The anon key is a public, RLS-gated credential, so this needs no auth — it lets a provider join with
 *  just an OAuth login and no hand-pasted Supabase config. Returns null when the deployment hasn't
 *  configured realtime (503) or the request fails. */
export async function fetchRealtimeConfig(
  apiBase: string,
  fetchImpl: typeof fetch = fetch
): Promise<RealtimeConfig | null> {
  try {
    const res = await fetchImpl(`${apiBase}/realtime/config`);
    if (!res.ok) return null;
    return realtimeConfigSchema.parse(await res.json());
  } catch {
    return null;
  }
}

export interface RegisterProviderDeps {
  apiBase: string;
  /** Bearer token (Clerk access token from the MCP OAuth login). */
  token: string;
  name: string;
  description: string;
  capabilities: string[];
  fetchImpl?: typeof fetch;
}

/** Register (idempotently, from the caller's perspective) and return the network provider id. */
export async function registerMonadixProvider(deps: RegisterProviderDeps): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.apiBase}/providers/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.token}`
    },
    body: JSON.stringify({
      name: deps.name,
      description: deps.description,
      agentFramework: 'monad',
      capabilities: deps.capabilities
    })
  });
  if (!res.ok) await monadixHttpError(res, 'monadix provider register failed');
  return registerProviderResponseSchema.parse(await res.json()).provider.id;
}

/** Deregister a provider (best-effort). A 404 means it's already gone, which is fine. */
export async function deregisterMonadixProvider(
  apiBase: string,
  token: string,
  providerId: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const res = await fetchImpl(`${apiBase}/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok && res.status !== 404) await monadixHttpError(res, 'monadix provider deregister failed');
}
