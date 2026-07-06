import type { ProviderCredential, ResolvedProviderConfig } from '@monad/sdk-atom';

export type OpenRouterProviderCall = {
  provider: ResolvedProviderConfig;
  credential: ProviderCredential;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
};

export interface OpenRouterUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
}

export function openRouterApiBase(call: OpenRouterProviderCall): string {
  return (call.credential.baseUrl ?? call.provider.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
}

export function openRouterHeaders(
  call: OpenRouterProviderCall,
  contentType = 'application/json'
): Record<string, string> {
  return {
    authorization: `Bearer ${call.credential.accessToken}`,
    ...(contentType ? { 'content-type': contentType } : {})
  };
}

export async function fetchOpenRouterJson<T>(
  call: OpenRouterProviderCall,
  path: string,
  body: Record<string, unknown>,
  method = 'POST'
): Promise<T> {
  const fetch = call.fetch ?? globalThis.fetch;
  const res = await fetch(`${openRouterApiBase(call)}${path}`, {
    method,
    headers: openRouterHeaders(call),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`OpenRouter ${path} failed: ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

export function usageFromOpenRouter(usage: OpenRouterUsage | undefined) {
  if (!usage) return undefined;
  const inputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  const totalTokens = finiteNumber(usage.total_tokens);
  const out = { inputTokens, outputTokens, totalTokens };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

export function openRouterApiOrigin(baseUrl: string | undefined): string {
  return (baseUrl ?? 'https://openrouter.ai').replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
}

export function openRouterDetailsUrl(base: string, details: string): string | undefined {
  try {
    const baseUrl = new URL(base);
    const detailsUrl = new URL(details, baseUrl);
    if (detailsUrl.origin !== baseUrl.origin) return undefined;
    return detailsUrl.toString();
  } catch {
    return undefined;
  }
}

export function openRouterModelPageUrl(modelId: string): string {
  return new URL(`/${modelId}`, 'https://openrouter.ai').toString();
}

export async function assertOpenRouterKey(
  base: string,
  cred: ProviderCredential,
  fetch: typeof globalThis.fetch
): Promise<void> {
  if (!cred.accessToken) throw new Error('OpenRouter auth failed: missing API key');
  const res = await fetch(`${base}/api/v1/auth/key`, {
    headers: { authorization: `Bearer ${cred.accessToken}` }
  });
  if (res.ok) return;
  throw new Error(`OpenRouter auth failed: ${res.status}`);
}
