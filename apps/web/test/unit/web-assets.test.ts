import { expect, test } from 'bun:test';

import { buildAssetMap, serveAssetFromMap } from '#/server/index';

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
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(await res.arrayBuffer()).toEqual(
    compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength)
  );
});

test('falls back to the gzip shell for deep links', () => {
  const compressed = Bun.gzipSync(Buffer.from('<!doctype html><title>monad</title>'));
  const assets = buildAssetMap([new File([compressed], 'apps/web/out.gz/index.html.gz') as File & { name: string }]);

  const res = serveAssetFromMap(assets, '/sessions/ses_123');

  expect(res.status).toBe(200);
  expect(res.headers.get('content-encoding')).toBe('gzip');
});

test('recognizes Bun asset names that include the absolute project path tail', () => {
  const compressed = Bun.gzipSync(Buffer.from('console.log("monad")'));
  const assets = buildAssetMap([
    new File([compressed], 'Users/zeke/Projects/monad/apps/web/out.gz/_next/static/chunks/app.js.gz') as File & {
      name: string;
    }
  ]);

  const res = serveAssetFromMap(assets, '/_next/static/chunks/app.js');

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
  expect(res.headers.get('content-encoding')).toBe('gzip');
  expect(res.headers.get('content-type')).toBe('image/x-icon');
});
