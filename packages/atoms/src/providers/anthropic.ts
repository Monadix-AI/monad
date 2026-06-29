import type { UsageLimits, UsageSnapshot } from '@monad/sdk-atom';

import { createAnthropic } from '@ai-sdk/anthropic';

import { defineAiSdkProvider, renderForCount } from './ai-sdk-adapter.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

const THINKING_BUDGET: Record<'minimal' | 'low' | 'medium' | 'high', number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384
};

export const anthropicProviderAtom = defineAiSdkProvider({
  type: 'anthropic',
  descriptor: PROVIDER_DESCRIPTORS.anthropic,
  rateLimitHeaderStyle: 'anthropic',

  build(call) {
    return createAnthropic({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).languageModel(call.modelId);
  },

  reasoningOptions(effort, maxThinkingTokens) {
    return {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: maxThinkingTokens ?? THINKING_BUDGET[effort] }
      }
    };
  },

  // Anthropic's catalogue route (x-api-key header, /v1/models) — not OpenAI-style, so enumerate
  // it here rather than via the gateway's generic /models fallback.
  async listModels(provider, cred, fetch = globalThis.fetch) {
    const base = (cred?.baseUrl ?? provider.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const headers = { 'x-api-key': cred?.accessToken ?? '', 'anthropic-version': '2023-06-01' };
    const models: Array<{ id: string; label?: string }> = [];
    let afterId: string | undefined;
    const seenPages = new Set<string>();
    for (;;) {
      const query = new URLSearchParams({ limit: '1000' });
      if (afterId) query.set('after_id', afterId);
      const pageKey = query.toString();
      if (seenPages.has(pageKey)) break;
      seenPages.add(pageKey);

      const res = await fetch(`${base}/v1/models?${query}`, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Anthropic models request failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
      }
      const json = (await res.json()) as {
        data?: Array<{ id: string; display_name?: string }>;
        has_more?: boolean;
        last_id?: string | null;
      };
      models.push(...(json.data ?? []).map((m) => ({ id: m.id, label: m.display_name })));
      if (!json.has_more || !json.last_id) break;
      afterId = json.last_id;
    }
    return models;
  },

  async getUsageLimits(provider, cred) {
    const base = (cred.baseUrl ?? provider.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const headers = {
      'x-api-key': cred.accessToken,
      'anthropic-version': '2023-06-01'
    };

    type RateLimitItem = { name: string; type: string; limit: number };
    type UsageRow = {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      model?: string;
    };

    async function fetchRateLimits(): Promise<
      Pick<UsageLimits, 'configuredInputTokensPerMinute' | 'configuredOutputTokensPerMinute'>
    > {
      try {
        const res = await fetch(`${base}/v1/organizations/rate_limits`, { headers });
        if (!res.ok) return {};
        const json = (await res.json()) as { data?: RateLimitItem[] };
        let inputTpm = 0;
        let outputTpm = 0;
        for (const item of json.data ?? []) {
          if (item.type === 'input_tokens_per_minute') inputTpm += item.limit;
          else if (item.type === 'output_tokens_per_minute') outputTpm += item.limit;
          else if (item.type === 'tokens_per_minute') {
            inputTpm += item.limit;
            outputTpm += item.limit;
          }
        }
        return {
          ...(inputTpm > 0 ? { configuredInputTokensPerMinute: inputTpm } : {}),
          ...(outputTpm > 0 ? { configuredOutputTokensPerMinute: outputTpm } : {})
        };
      } catch {
        return {};
      }
    }

    async function fetchUsage(bucketWidth: string, windowSeconds: number): Promise<UsageSnapshot | undefined> {
      const now = Math.floor(Date.now() / 1000);
      const start = now - windowSeconds;
      try {
        const url =
          `${base}/v1/organizations/usage_report/messages` +
          `?starting_at=${start}&ending_at=${now}&bucket_width=${bucketWidth}&group_by[]=model`;
        const res = await fetch(url, { headers });
        if (!res.ok) return undefined;
        const json = (await res.json()) as { data?: UsageRow[] };
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        const byModel: Record<string, { inputTokens: number; outputTokens: number }> = {};
        for (const row of json.data ?? []) {
          inputTokens += row.input_tokens ?? 0;
          outputTokens += row.output_tokens ?? 0;
          cacheReadTokens += row.cache_read_input_tokens ?? 0;
          if (row.model) {
            const m = byModel[row.model] ?? { inputTokens: 0, outputTokens: 0 };
            m.inputTokens += row.input_tokens ?? 0;
            m.outputTokens += row.output_tokens ?? 0;
            byModel[row.model] = m;
          }
        }
        if (inputTokens === 0 && outputTokens === 0) return undefined;
        return {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
          ...(Object.keys(byModel).length > 0 ? { byModel } : {})
        };
      } catch {
        return undefined;
      }
    }

    const [rateLimits, usedLast5h, usedLastDay, usedLastWeek] = await Promise.all([
      fetchRateLimits(),
      fetchUsage('1h', 5 * 3600),
      fetchUsage('1h', 24 * 3600),
      fetchUsage('1d', 7 * 24 * 3600)
    ]);

    const out: UsageLimits = {
      ...rateLimits,
      ...(usedLast5h ? { usedLast5h } : {}),
      ...(usedLastDay ? { usedLastDay } : {}),
      ...(usedLastWeek ? { usedLastWeek } : {})
    };
    return Object.values(out).some((v) => v !== undefined) ? out : undefined;
  },

  async countTokens(call) {
    const input = renderForCount(call);
    if (!input.text) return undefined; // empty messages array is rejected by the endpoint
    try {
      const fetchImpl = call.fetch ?? globalThis.fetch;
      const base = (call.credential.baseUrl ?? call.provider.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
      const res = await fetchImpl(`${base}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: {
          'x-api-key': call.credential.accessToken,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: call.modelId,
          ...(input.system ? { system: input.system } : {}),
          messages: [{ role: 'user', content: input.text }],
          ...(input.tools?.length
            ? {
                tools: input.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters ?? { type: 'object', properties: {} }
                }))
              }
            : {})
        })
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { input_tokens?: unknown };
      return typeof json.input_tokens === 'number' && Number.isFinite(json.input_tokens)
        ? json.input_tokens
        : undefined;
    } catch {
      return undefined;
    }
  }
});
