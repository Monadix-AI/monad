// web_search — pluggable web search. Provider interface with a keyless DuckDuckGo fallback;
// all adapters are plain HTTP with no SDK dependencies and are fetch-injectable for tests.
// Configuration flows in via configureWebSearch() (called from main.ts after config load).

import type { Tool, ToolContext } from '../types.ts';

import { z } from 'zod';

import { toolResult } from '../types.ts';
import { createApprovalFetch } from './net.ts';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;
const braveSearchResponseSchema = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({ title: z.string().optional(), url: z.string().optional(), description: z.string().optional() })
        )
        .optional()
    })
    .optional()
});

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchError';
  }
}

export interface SearchProvider {
  name: string;
  networkHost: string;
  isConfigured(): boolean;
  search(query: string, count: number, fetchImpl: typeof fetch): Promise<WebSearchResult[]>;
}

export function createBraveProvider(apiKey: string): SearchProvider {
  return {
    name: 'brave',
    networkHost: 'api.search.brave.com',
    isConfigured: () => true,
    async search(query, count, fetchImpl) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(count));
      const res = await fetchImpl(url, { headers: { accept: 'application/json', 'x-subscription-token': apiKey } });
      if (!res.ok) throw new WebSearchError(`brave search failed: ${res.status}`);
      const body = braveSearchResponseSchema.parse(await res.json());
      return (body.web?.results ?? []).slice(0, count).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? ''
      }));
    }
  };
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// DDG result links are redirects like `//duckduckgo.com/l/?uddg=<encoded-target>&rut=…`
// — decode to the real target URL.
function decodeDdgHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return href.startsWith('//') ? `https:${href}` : href;
}

/** Pure parser so it's unit-testable on a fixture without an HTTP call. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];
  const results: WebSearchResult[] = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link?.[1]) continue;
    results.push({
      title: stripTags(link[2] ?? ''),
      url: decodeDdgHref(link[1]),
      snippet: stripTags(snippets[i]?.[1] ?? '')
    });
  }
  return results;
}

export const duckDuckGoProvider: SearchProvider = {
  name: 'ddgs',
  networkHost: 'html.duckduckgo.com',
  isConfigured: () => true, // keyless fallback; always available
  async search(query, count, fetchImpl) {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    const res = await fetchImpl(url, { headers: { accept: 'text/html', 'user-agent': 'monad/0.0' } });
    if (!res.ok) throw new WebSearchError(`duckduckgo search failed: ${res.status}`);
    return parseDuckDuckGoHtml(await res.text()).slice(0, count);
  }
};

interface WebSearchConfig {
  provider: 'auto' | 'native' | 'brave' | 'ddgs';
  braveApiKey?: string;
}

let _webSearchConfig: WebSearchConfig | null = null;

/** Call once after config load to wire up web search from config.agent.tools.webSearch. */
export function configureWebSearch(cfg: WebSearchConfig): void {
  _webSearchConfig = cfg;
}

export function selectProvider(): SearchProvider {
  const { provider, braveApiKey } = _webSearchConfig ?? { provider: 'auto' as const };
  if (provider === 'brave') {
    if (!braveApiKey) throw new WebSearchError('web search provider is "brave" but no brave.apiKey is configured');
    return createBraveProvider(braveApiKey);
  }
  // Local execution only runs when the model provider did not execute the search server-side.
  // 'auto', 'native', and 'ddgs' all fall back to the free, keyless DuckDuckGo provider here.
  return duckDuckGoProvider;
}

const webSearchInput = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).max(MAX_COUNT).optional()
});

const webSearchTool: Tool<z.infer<typeof webSearchInput>, { provider: string; results: WebSearchResult[] }> = {
  name: 'web_search',
  description:
    'Search the web and return titles, URLs, and snippets. Uses DuckDuckGo (free, no API key required), or Brave if explicitly configured.',
  scopes: [{ resource: 'net:fetch' }],
  inputExamples: [{ query: 'bun test runner cli flags' }, { query: 'RFC 8707 resource indicators', count: 5 }],
  inputSchema: webSearchInput,
  // Anthropic and OpenAI have provider-native server-side search — the adapter emits the
  // built-in tool spec and the loop skips local execution for those providers. For all
  // others (for example provider-routed models) the run() below fires (DDG or Brave).
  providerTool: {
    anthropic: { type: 'web_search_20260209' },
    openai: { type: 'web_search_preview' }
  },
  run: async ({ query, count }, ctx: ToolContext) => {
    const provider = selectProvider();
    const results = await provider.search(
      query,
      count ?? DEFAULT_COUNT,
      createApprovalFetch(ctx, { reason: 'web_search' })
    );
    return toolResult({ provider: provider.name, results });
  }
};

const webSearchTools: Tool[] = [webSearchTool as Tool];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => webSearchTools;
