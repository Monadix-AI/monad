// Resolve mem0's LLM + embedder from Monad's existing model config — Monad is the single registry,
// mem0 just *selects* from it (by profile alias or `providerId:modelId`). No environment variables:
// provider type, model id, API key, and base URL all come from cfg.model + auth.credentialPool.

import type { MonadAuth, MonadConfig } from '@monad/home';

import { DEFAULT_PROFILE_ALIAS, resolveModelRole } from '@/config/resolve.ts';

export interface Mem0ModelSpec {
  provider: string; // mem0 provider name
  model: string;
  apiKey?: string;
  baseUrl?: string;
}
export interface Mem0Models {
  llm: Mem0ModelSpec;
  embedder: Mem0ModelSpec;
  dim: number;
}
export interface Mem0Resolution {
  models?: Mem0Models; // present only when fully resolvable
  error?: string;
  llm: string | null; // selected reference (for status display)
  embedder: string | null;
  dim: number | null;
}

export interface Mem0Selection {
  llm?: string;
  embedder?: string;
  embedDim?: number;
}

// Monad provider type → mem0 provider name + whether it can produce embeddings. Anything not listed
// that carries a base URL is routed through mem0's OpenAI provider (covers OpenAI-compatible servers,
// local Ollama-via-/v1, LM Studio, etc.).
function mapProvider(type: string, hasBaseUrl: boolean): { provider: string; canEmbed: boolean } | null {
  switch (type) {
    case 'openai':
      return { provider: 'openai', canEmbed: true };
    case 'ollama':
      return { provider: 'ollama', canEmbed: true };
    case 'huggingface':
      return { provider: 'huggingface', canEmbed: true };
    case 'azure':
      return { provider: 'azure_openai', canEmbed: true };
    case 'google':
      return { provider: 'gemini', canEmbed: true };
    case 'anthropic':
      return { provider: 'anthropic', canEmbed: false };
    case 'groq':
      return { provider: 'groq', canEmbed: false };
    case 'openrouter':
      return { provider: 'openai', canEmbed: true };
    default:
      return hasBaseUrl ? { provider: 'openai', canEmbed: true } : null;
  }
}

// Known embedding dimensions; falls back to 1536 (OpenAI small) when unknown — overridable via config.
function embedDimFor(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('text-embedding-3-large')) return 3072;
  if (m.includes('text-embedding-3-small') || m.includes('ada-002')) return 1536;
  if (m.includes('nomic-embed')) return 768;
  if (m.includes('mxbai-embed') || m.includes('bge-large')) return 1024;
  if (m.includes('all-minilm') || m.includes('bge-small')) return 384;
  return 1536;
}

function resolveRef(
  cfg: MonadConfig,
  auth: MonadAuth | null,
  ref: string
): { spec?: Mem0ModelSpec; canEmbed: boolean; error?: string } {
  let providerId: string | undefined;
  let modelId: string | undefined;
  const profile = cfg.model.profiles.find((p) => p.alias === ref);
  if (profile) {
    providerId = profile.routes.chat.provider;
    modelId = profile.routes.chat.modelId;
  } else if (ref.includes(':')) {
    const i = ref.indexOf(':');
    providerId = ref.slice(0, i);
    modelId = ref.slice(i + 1);
  }
  if (!providerId || !modelId) return { canEmbed: false, error: `unknown model '${ref}'` };
  const provider = cfg.model.providers.find((p) => p.id === providerId);
  if (!provider) return { canEmbed: false, error: `provider '${providerId}' not configured` };
  const cred = auth?.credentialPool?.[providerId]?.[0];
  const baseUrl =
    cred?.baseUrl ?? provider.baseUrl ?? (provider.type === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined);
  const mapped = mapProvider(provider.type, Boolean(baseUrl));
  if (!mapped) return { canEmbed: false, error: `provider type '${provider.type}' isn't supported by mem0` };
  return {
    spec: { provider: mapped.provider, model: modelId, apiKey: cred?.accessToken, baseUrl },
    canEmbed: mapped.canEmbed
  };
}

/** Resolve the active mem0 model selection against Monad's config. Defaults: LLM ← default profile,
 *  embedder ← default profile's embedding role. Returns an `error` (not `models`) when anything is unresolvable. */
export function resolveMem0Models(cfg: MonadConfig, auth: MonadAuth | null, sel: Mem0Selection): Mem0Resolution {
  const llmRef = sel.llm ?? DEFAULT_PROFILE_ALIAS;
  const embRef = sel.embedder ?? resolveModelRole(cfg.model, 'embedding') ?? null;
  if (!llmRef) return { llm: null, embedder: embRef, dim: null, error: 'no LLM selected (set memory.mem0.llm)' };
  if (!embRef)
    return {
      llm: llmRef,
      embedder: null,
      dim: null,
      error: 'no embedding model selected (set memory.mem0.embedder or the default profile embedding role)'
    };
  const llm = resolveRef(cfg, auth, llmRef);
  if (!llm.spec) return { llm: llmRef, embedder: embRef, dim: null, error: `LLM: ${llm.error}` };
  const emb = resolveRef(cfg, auth, embRef);
  if (!emb.spec) return { llm: llmRef, embedder: embRef, dim: null, error: `embedder: ${emb.error}` };
  if (!emb.canEmbed)
    return {
      llm: llmRef,
      embedder: embRef,
      dim: null,
      error: `embedder provider '${emb.spec.provider}' can't produce embeddings — pick an OpenAI/Ollama/HF model`
    };
  const dim = sel.embedDim ?? embedDimFor(emb.spec.model);
  return { models: { llm: llm.spec, embedder: emb.spec, dim }, llm: llmRef, embedder: embRef, dim };
}
