import { expect, test } from 'bun:test';

import { type DownloadFetch, type DownloadProgress, downloadBytes } from '@/services/download.ts';

function streamChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

test('downloadBytes streams bytes and reports total progress when content-length is known', async () => {
  const progress: DownloadProgress[] = [];
  const fetchImpl: DownloadFetch = async (_url, init) => {
    expect(new Headers(init?.headers).get('accept')).toBe('application/gzip');
    return new Response(streamChunks(['abc', 'defg']), {
      headers: {
        'content-length': '7',
        'content-type': 'application/gzip'
      }
    });
  };

  const result = await downloadBytes('https://example.test/archive.tar.gz', {
    accept: 'application/gzip',
    allowedContentTypes: ['application/gzip'],
    fetch: fetchImpl,
    onProgress: (event) => progress.push(event)
  });

  expect(new TextDecoder().decode(result.bytes)).toBe('abcdefg');
  expect(result.contentType).toBe('application/gzip');
  expect(progress).toEqual([
    { loadedBytes: 3, totalBytes: 7, percent: 42.857142857142854 },
    { loadedBytes: 7, totalBytes: 7, percent: 100 }
  ]);
});

test('downloadBytes reports loaded bytes when total size is unknown', async () => {
  const progress: DownloadProgress[] = [];
  const fetchImpl: DownloadFetch = async () =>
    new Response(streamChunks(['ab', 'cd']), {
      headers: { 'content-type': 'application/octet-stream' }
    });

  const result = await downloadBytes('https://example.test/tool', {
    allowedContentTypes: ['application/octet-stream'],
    fetch: fetchImpl,
    onProgress: (event) => progress.push(event)
  });

  expect(new TextDecoder().decode(result.bytes)).toBe('abcd');
  expect(progress).toEqual([
    { loadedBytes: 2, totalBytes: undefined, percent: undefined },
    { loadedBytes: 4, totalBytes: undefined, percent: undefined }
  ]);
});

test('downloadBytes accepts allowed content types with response parameters', async () => {
  const fetchImpl: DownloadFetch = async () =>
    new Response(streamChunks(['raw']), {
      headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' }
    });

  const result = await downloadBytes('https://api.github.test/repos/owner/repo/contents/atom-pack.json', {
    allowedContentTypes: ['application/vnd.github.raw'],
    fetch: fetchImpl
  });

  expect(new TextDecoder().decode(result.bytes)).toBe('raw');
  expect(result.contentType).toBe('application/vnd.github.raw; charset=utf-8');
});

test('downloadBytes rejects unexpected content types', async () => {
  const fetchImpl: DownloadFetch = async () =>
    new Response(streamChunks(['not an archive']), { headers: { 'content-type': 'text/html; charset=utf-8' } });

  await expect(
    downloadBytes('https://example.test/archive.tar.gz', {
      allowedContentTypes: ['application/gzip'],
      fetch: fetchImpl
    })
  ).rejects.toThrow('unexpected content type');
});
