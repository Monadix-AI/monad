import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

import { defineAiSdkProvider, renderForCount } from './ai-sdk-adapter/index.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const googleTokenCountResponseSchema = z.object({ totalTokens: z.unknown().optional() });
const googleModelsResponseSchema = z.object({
  models: z.array(z.object({ name: z.string().optional(), displayName: z.string().optional() })).optional(),
  nextPageToken: z.string().optional()
});

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
      const json = googleTokenCountResponseSchema.parse(await res.json());
      return typeof json.totalTokens === 'number' && Number.isFinite(json.totalTokens) ? json.totalTokens : undefined;
    } catch {
      return undefined;
    }
  },

  // Gemini exposes a non-OpenAI catalogue route (x-goog-api-key, `models/…` ids).
  async listModels(provider, cred, fetch = globalThis.fetch) {
    const base = (cred?.baseUrl ?? provider.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    const headers: Record<string, string> = cred?.accessToken ? { 'x-goog-api-key': cred.accessToken } : {};
    const models: Array<{ id: string; label?: string }> = [];
    let pageToken: string | undefined;
    const seenPages = new Set<string>();
    for (;;) {
      const query = new URLSearchParams({ pageSize: '1000' });
      if (pageToken) query.set('pageToken', pageToken);
      const pageKey = query.toString();
      if (seenPages.has(pageKey)) break;
      seenPages.add(pageKey);

      const res = await fetch(`${base}/models?${query}`, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Google models request failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
      }
      const json = googleModelsResponseSchema.parse(await res.json());
      models.push(
        ...(json.models ?? []).map((m) => ({ id: (m.name ?? '').replace(/^models\//, ''), label: m.displayName }))
      );
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
    return models;
  }
});
