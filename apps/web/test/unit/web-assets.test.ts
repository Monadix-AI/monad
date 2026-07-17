import { expect, test } from 'bun:test';

import { buildAssetMap, serveAssetFromMap } from '#/server/index';

test('declares one ICO favicon in the static web shell', async () => {
  const html = await Bun.file(new URL('../../index.html', import.meta.url)).text();
  const iconLinks = html.match(/<link\b[^>]*\brel="icon"[^>]*\/>/g) ?? [];

  expect(iconLinks).toEqual(['<link href="/favicon.ico" rel="icon" sizes="any" />']);
});

test('serves gzip-embedded web assets with original URL and content type', async () => {
  const compressed = Bun.gzipSync(Buffer.from('<!doctype html><title>monad</title>'));
  const assets = buildAssetMap([
    new File([compressed], 'apps/web/out.gz/index.html.gz', {
      type: 'application/gzip'
    }) as File & { name: string }
  ]);

  const res = serveAssetFromMap(assets, '/');

  expect(res.status).toBe(200);
  expect(res.headers.get('content-encoding')).toBe('gzip');
  expect(res.headers.get('cache-control')).toBe('no-cache');
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await res.arrayBuffer()).toEqual(
    compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength)
  );
});

test('caches content-hashed release assets immutably', () => {
  const compressed = Bun.gzipSync(Buffer.from('body { color: red }'));
  const assets = buildAssetMap([
    new File([compressed], 'apps/web/out.gz/assets/style-ABC123.css.gz') as File & { name: string }
  ]);

  const res = serveAssetFromMap(assets, '/assets/style-ABC123.css');

  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
});

test('returns 404 for a missing hashed asset instead of the SPA shell', async () => {
  const compressed = Bun.gzipSync(Buffer.from('<!doctype html><title>monad</title>'));
  const assets = buildAssetMap([new File([compressed], 'apps/web/out.gz/index.html.gz') as File & { name: string }]);

  const res = serveAssetFromMap(assets, '/assets/style-OLD.css');

  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toBe('text/plain;charset=utf-8');
  expect(await res.text()).toBe('Not found');
});

test('falls back to the gzip shell for deep links', () => {
  const compressed = Bun.gzipSync(Buffer.from('<!doctype html><title>monad</title>'));
  const assets = buildAssetMap([new File([compressed], 'apps/web/out.gz/index.html.gz') as File & { name: string }]);

  const res = serveAssetFromMap(assets, '/sessions/undefined');

  expect(res.status).toBe(200);
  expect(res.headers.get('content-encoding')).toBe('gzip');
});

test('recognizes Bun asset names that include the absolute project path tail', () => {
  const compressed = Bun.gzipSync(Buffer.from('console.log("monad")'));
  const assets = buildAssetMap([
    new File([compressed], 'Users/zeke/Projects/monad/apps/web/out.gz/assets/app.js.gz') as File & {
      name: string;
    }
  ]);

  const res = serveAssetFromMap(assets, '/assets/app.js');

  expect(res.status).toBe(200);
  expect(res.headers.get('content-encoding')).toBe('gzip');
  expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
});

test('serves the exported favicon from gzip-embedded release assets', async () => {
  const compressed = Bun.gzipSync(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
  const assets = buildAssetMap([new File([compressed], 'apps/web/out.gz/favicon.svg.gz') as File & { name: string }]);

  const res = serveAssetFromMap(assets, '/favicon.svg');

  expect(res.status).toBe(200);
  expect(res.headers.get('content-encoding')).toBe('gzip');
  expect(res.headers.get('content-type')).toBe('image/svg+xml');
  expect(await res.arrayBuffer()).toEqual(
    compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength)
  );
});

test('serves the fallback ico favicon from gzip-embedded release assets', async () => {
  const compressed = Bun.gzipSync(Buffer.from('ico'));
  const assets = buildAssetMap([new File([compressed], 'apps/web/out.gz/favicon.ico.gz') as File & { name: string }]);

  const res = serveAssetFromMap(assets, '/favicon.ico');

  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
  expect(res.headers.get('content-encoding')).toBe('gzip');
  expect(res.headers.get('content-type')).toBe('image/x-icon');
});
