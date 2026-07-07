import { expect, test } from 'bun:test';

import { createHttp2Fetch, getHttp2Fetch } from '@/infra/http2-fetch.ts';

type CapturedCall = {
  input: string | URL | Request;
  init?: RequestInit & { protocol?: string };
};

function captureFetch(calls: CapturedCall[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit & { protocol?: string }) => {
    calls.push({ input, init });
    return Promise.resolve(new Response('ok'));
  }) as unknown as typeof fetch;
}

test('getHttp2Fetch returns a process-wide singleton', () => {
  expect(getHttp2Fetch()).toBe(getHttp2Fetch());
});

test('createHttp2Fetch pins HTTPS requests to HTTP/2', async () => {
  const calls: CapturedCall[] = [];
  const fetch = createHttp2Fetch(captureFetch(calls));

  await fetch('https://api.example.test/v1/chat/completions', { method: 'POST' });

  expect(calls[0]?.init?.protocol).toBe('http2');
  expect(calls[0]?.init?.method).toBe('POST');
});

test('createHttp2Fetch preserves an explicit protocol option', async () => {
  const calls: CapturedCall[] = [];
  const fetch = createHttp2Fetch(captureFetch(calls));

  await fetch('https://api.example.test/v1/chat/completions', { protocol: 'http1.1' } as RequestInit);

  expect(calls[0]?.init?.protocol).toBe('http1.1');
});

test('createHttp2Fetch leaves non-HTTPS requests unchanged', async () => {
  const calls: CapturedCall[] = [];
  const fetch = createHttp2Fetch(captureFetch(calls));

  await fetch('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST' });

  expect(calls[0]?.init).toEqual({ method: 'POST' });
});
