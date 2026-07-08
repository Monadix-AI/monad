import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  configureSandboxNet,
  configureWebSearch,
  createBraveProvider,
  duckDuckGoProvider,
  parseDuckDuckGoHtml,
  registerWebSearchTools,
  selectProvider,
  ToolSecurityError,
  WebSearchError
} from '#/capabilities/tools';

function jsonFetch(body: unknown, capture?: (req: Request) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (capture)
      capture(new Request(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, init));
    return Response.json(body);
  }) as typeof fetch;
}

function htmlFetch(html: string): typeof fetch {
  return (async (_input: string | URL | Request) =>
    new Response(html, { headers: { 'content-type': 'text/html' } })) as typeof fetch;
}

beforeEach(() => configureWebSearch({ provider: 'auto' }));
afterEach(() => {
  configureWebSearch({ provider: 'auto' });
  configureSandboxNet('unrestricted');
});

// ── Brave factory ─────────────────────────────────────────────────────────────

test('createBraveProvider maps results and sends the subscription token', async () => {
  let seen: Request | undefined;
  const f = jsonFetch({ web: { results: [{ title: 'T', url: 'https://x.test', description: 'snip' }] } }, (req) => {
    seen = req;
  });
  const results = await createBraveProvider('bk-1').search('hello', 5, f);
  expect(results).toEqual([{ title: 'T', url: 'https://x.test', snippet: 'snip' }]);
  expect(seen?.headers.get('x-subscription-token')).toBe('bk-1');
  expect(new URL(seen?.url ?? '').searchParams.get('q')).toBe('hello');
});

// ── DuckDuckGo parser ────────────────────────────────────────────────────────

const DDG_HTML = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=xx">Example &amp; Co</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">A <b>snippet</b> here</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.test%2Fb">Foo</a>
  <a class="result__snippet">second snippet</a>
</div>`;

test('parseDuckDuckGoHtml decodes redirect URLs and strips tags', () => {
  const r = parseDuckDuckGoHtml(DDG_HTML);
  expect(r).toHaveLength(2);
  expect(r[0]).toEqual({ title: 'Example & Co', url: 'https://example.com/a', snippet: 'A snippet here' });
  expect(r[1]?.url).toBe('https://foo.test/b');
});

test('duckDuckGo provider returns parsed results and is always configured', async () => {
  expect(duckDuckGoProvider.isConfigured()).toBe(true);
  const r = await duckDuckGoProvider.search('q', 10, htmlFetch(DDG_HTML));
  expect(r.map((x) => x.url)).toEqual(['https://example.com/a', 'https://foo.test/b']);
});

// ── selectProvider via configureWebSearch ────────────────────────────────────

test('selectProvider returns ddgs when provider is auto (default to free)', () => {
  configureWebSearch({ provider: 'auto' });
  expect(selectProvider().name).toBe('ddgs');
});

test('selectProvider returns ddgs when provider is auto even with key configured', () => {
  configureWebSearch({ provider: 'auto', braveApiKey: 'bk' });
  expect(selectProvider().name).toBe('ddgs');
});

test('selectProvider honors explicit provider=ddgs regardless of key', () => {
  configureWebSearch({ provider: 'ddgs', braveApiKey: 'k' });
  expect(selectProvider().name).toBe('ddgs');
});

test('selectProvider uses ddgs as the local fallback for provider=native', () => {
  configureWebSearch({ provider: 'native', braveApiKey: 'k' });
  expect(selectProvider().name).toBe('ddgs');
});

test('selectProvider throws when provider=brave but no key configured', () => {
  configureWebSearch({ provider: 'brave' });
  expect(() => selectProvider()).toThrow(WebSearchError);
});

test('web_search requests network_access for the selected local provider host', async () => {
  configureSandboxNet('none');
  configureWebSearch({ provider: 'brave', braveApiKey: 'bk' });
  const [tool] = registerWebSearchTools({});
  const calls: Array<{ tool: string; key?: string; input: unknown }> = [];

  await expect(
    tool?.run?.(
      { query: 'monad sandbox', count: 1 },
      {
        sessionId: 'ses_1',
        log: () => {},
        gate: async (req) => {
          calls.push({ tool: req.tool, key: req.key, input: req.input });
          return { allow: false, reason: 'deny test' };
        }
      }
    )
  ).rejects.toBeInstanceOf(ToolSecurityError);

  expect(calls).toEqual([
    {
      tool: 'network_access',
      key: 'api.search.brave.com',
      input: {
        url: 'https://api.search.brave.com/res/v1/web/search?q=monad+sandbox&count=1',
        host: 'api.search.brave.com',
        protocol: 'https',
        reason: 'web_search',
        defaultScope: 'session',
        rememberScopes: ['once', 'session', 'agent', 'global'],
        displayHint: {
          kind: 'resource-approval',
          resource: 'network',
          subject: 'api.search.brave.com',
          defaultScope: 'session',
          rememberScopes: ['once', 'session', 'agent', 'global']
        }
      }
    }
  ]);
});
