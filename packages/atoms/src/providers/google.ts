import { createGoogleGenerativeAI } from '@ai-sdk/google';

import { defineAiSdkProvider, renderForCount } from './ai-sdk-adapter.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const googleProviderAtom = defineAiSdkProvider({
  type: 'google',
  descriptor: PROVIDER_DESCRIPTORS.google,

  build(call) {
    return createGoogleGenerativeAI({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).languageModel(call.modelId);
  },

  buildEmbeddingModel(call) {
    return createGoogleGenerativeAI({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).embeddingModel(call.modelId);
  },

  // Gemini's native count-tokens route: POST models/{id}:countTokens → { totalTokens }.
  async countTokens(call) {
    const input = renderForCount(call);
    if (!input.text) return undefined;
    try {
      const fetchImpl = call.fetch ?? globalThis.fetch;
      const base = (call.credential.baseUrl ?? call.provider.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
      const id = call.modelId.replace(/^models\//, '');
      const text = input.system ? `${input.system}\n${input.text}` : input.text;
      const res = await fetchImpl(`${base}/models/${id}:countTokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(call.credential.accessToken ? { 'x-goog-api-key': call.credential.accessToken } : {})
        },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }] })
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { totalTokens?: unknown };
      return typeof json.totalTokens === 'number' && Number.isFinite(json.totalTokens) ? json.totalTokens : undefined;
    } catch {
      return undefined;
    }
  },

  // Gemini exposes a non-OpenAI catalogue route (x-goog-api-key, `models/…` ids).
  async listModels(provider, cred, fetch = globalThis.fetch) {
    const base = (cred?.baseUrl ?? provider.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: cred?.accessToken ? { 'x-goog-api-key': cred.accessToken } : {}
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google models request failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }
    const json = (await res.json()) as { models?: Array<{ name?: string; displayName?: string }> };
    return (json.models ?? []).map((m) => ({ id: (m.name ?? '').replace(/^models\//, ''), label: m.displayName }));
  }
});
