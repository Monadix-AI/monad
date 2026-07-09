import type { NextApiRequest, NextApiResponse } from 'next';

import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { resolveDaemonUrl } from '@monad/home/network-endpoints';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true
  }
};

function daemonUrlFromConfig(raw: string): string | null {
  const network = (JSON.parse(raw) as { network?: Parameters<typeof resolveDaemonUrl>[0]['network'] })?.network;
  if (!network?.port) return null;
  return resolveDaemonUrl({ network, env: process.env });
}

function readDaemonConfigUrl(): string | null {
  const configPaths = [
    process.env.MONAD_HOME ? join(process.env.MONAD_HOME, 'configs', 'config.json') : undefined,
    resolve(process.cwd(), '../..', '.dev', '.monad', 'configs', 'config.json'),
    process.env.HOME ? join(process.env.HOME, '.monad', 'configs', 'config.json') : undefined
  ].filter((path): path is string => !!path);

  for (const configPath of configPaths) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const url = daemonUrlFromConfig(raw);
      if (url) return url;
    } catch {}
  }
  return null;
}

export function readDaemonUrl(): string {
  if (process.env.MONAD_URL) return resolveDaemonUrl({ env: process.env });
  return readDaemonConfigUrl() ?? resolveDaemonUrl({ env: process.env });
}

function isLoopbackHttps(target: string): boolean {
  const url = new URL(target);
  return url.protocol === 'https:' && LOOPBACK_HOSTS.has(url.hostname);
}

function headerEntries(headers: Headers): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of headers.entries()) entries[key] = value;
  return entries;
}

async function fetchLoopbackHttps(
  target: string,
  init: { method: string; headers: Headers; body?: ArrayBuffer }
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      target,
      {
        method: init.method,
        headers: headerEntries(init.headers),
        rejectUnauthorized: false
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
          } else if (value !== undefined) {
            headers.set(key, String(value));
          }
        }
        resolve(
          new Response(Readable.toWeb(res) as unknown as ReadableStream, {
            status: res.statusCode ?? 200,
            statusText: res.statusMessage,
            headers
          })
        );
      }
    );
    req.on('error', reject);
    if (init.body) req.end(Buffer.from(init.body));
    else req.end();
  });
}

function fetchDaemon(
  target: string,
  init: { method: string; headers: Headers; body?: ArrayBuffer }
): Promise<Response> {
  if (isLoopbackHttps(target)) return fetchLoopbackHttps(target, init);
  return fetch(target, init);
}

function requestBody(req: NextApiRequest): Promise<ArrayBuffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(undefined);
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      resolveBody(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    });
    req.on('error', reject);
  });
}

function requestHeaders(req: NextApiRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === 'host' || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function responseHeaders(upstream: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'transfer-encoding') headers[key] = value;
  });
  return headers;
}

async function writeResponse(upstream: Response, res: NextApiResponse): Promise<void> {
  res.status(upstream.status);
  for (const [key, value] of Object.entries(responseHeaders(upstream))) res.setHeader(key, value);
  if (!upstream.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolveWrite, reject) => {
    const body = Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
    body.on('error', reject);
    body.on('end', resolveWrite);
    body.pipe(res);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const path = Array.isArray(req.query.path) ? req.query.path : [];
  const daemon = readDaemonUrl().replace(/\/$/, '');
  const search = req.url?.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '';
  const target = `${daemon}/${path.join('/')}${search}`;

  try {
    const upstream = await fetchDaemon(target, {
      body: await requestBody(req),
      headers: requestHeaders(req),
      method: req.method ?? 'GET'
    });
    await writeResponse(upstream, res);
  } catch {
    res.status(502).send('Bad Gateway');
  }
}
