import type { ModelInfo, ProviderCredential, ResolvedProviderConfig } from '@monad/sdk-atom';
import type { ModelProviderRegistry } from '../provider.ts';

import { openAiPrice } from '@monad/protocol';
import { z } from 'zod';

const providerModelsResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        pricing: z.record(z.string(), z.unknown()).nullable().optional()
      })
    )
    .optional()
});

// A successful authenticated list proves the credential works without spending any generation
// tokens — the preferred connection test. Delegates to the provider's own listModels; providers
// without one fall back to the generic OpenAI-style /models route using their descriptor base URL.
export async function fetchProviderModels(
  provider: ResolvedProviderConfig,
  cred: ProviderCredential,
  registry: ModelProviderRegistry,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<ModelInfo[]> {
  const impl = registry.get(provider.type);
  if (impl?.listModels) return impl.listModels(provider, cred, fetchImpl);

  const base = (cred.baseUrl ?? provider.baseUrl ?? impl?.descriptor.defaultBaseUrl)?.replace(/\/$/, '');
  if (!base) throw new Error(`cannot list models: provider "${provider.id}" (${provider.type}) has no base url`);
  const res = await fetchImpl(`${base}/models`, { headers: { authorization: `Bearer ${cred.accessToken}` } });
  if (!res.ok) throw new Error(await modelsHttpError(res));
  const json = providerModelsResponseSchema.parse(await res.json());
  return (json.data ?? []).map((m) => {
    const price = openAiPrice(m.pricing);
    return price ? { id: m.id, label: m.name, price } : { id: m.id, label: m.name };
  });
}

export async function listProviderModels(
  provider: ResolvedProviderConfig,
  cred: ProviderCredential,
  registry: ModelProviderRegistry,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<ModelInfo[]> {
  try {
    return await fetchProviderModels(provider, cred, registry, fetchImpl);
  } catch {
    return [];
  }
}

async function modelsHttpError(res: Response): Promise<string> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 200);
  } catch {
    // ignore — the status alone is enough
  }
  return `models request failed: ${res.status}${body ? ` — ${body}` : ''}`;
}
