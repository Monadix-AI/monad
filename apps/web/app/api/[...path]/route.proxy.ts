import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { proxyResponseBody } from '@/lib/proxy-stream';

const runtime = 'nodejs';
const dynamic = 'force-dynamic';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

interface DaemonConfig {
  network?: {
    port?: number;
    remoteAccess?: {
      enabled?: boolean;
      allowInsecureHttp?: boolean;
    };
  };
}

function daemonScheme(cfg: DaemonConfig | null): 'http' | 'https' {
  const remote = cfg?.network?.remoteAccess;
  return remote?.enabled && !remote.allowInsecureHttp ? 'https' : 'http';
}

function readDaemonConfig(): DaemonConfig | null {
  const configPaths = [
    process.env.MONAD_HOME ? join(process.env.MONAD_HOME, 'configs', 'config.json') : undefined,
    resolve(process.cwd(), '../..', '.dev', '.monad', 'configs', 'config.json'),
    process.env.HOME ? join(process.env.HOME, '.monad', 'configs', 'config.json') : undefined
  ].filter((path): path is string => !!path);

  for (const configPath of configPaths) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8')) as DaemonConfig;
    } catch {}
  }
  return null;
}

export function readDaemonUrl(): string {
  if (process.env.MONAD_URL) return process.env.MONAD_URL;

  const cfg = readDaemonConfig();
  const port = process.env.MONAD_PORT || cfg?.network?.port || 52749;

  return `${daemonScheme(cfg)}://127.0.0.1:${port}`;
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

async function proxy(req: Request, { params }: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const { path = [] } = await params;
  const daemon = readDaemonUrl().replace(/\/$/, '');
  const url = new URL(req.url);
  const target = `${daemon}/${path.join('/')}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete('host');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();

  try {
    const upstream = await fetchDaemon(target, { method: req.method, headers, body });
    const resHeaders = new Headers(upstream.headers);
    resHeaders.delete('transfer-encoding');
    return new Response(proxyResponseBody(upstream), { status: upstream.status, headers: resHeaders });
  } catch {
    return new Response('Bad Gateway', { status: 502 });
  }
}

const GET = proxy;
const POST = proxy;
const PUT = proxy;
const PATCH = proxy;
const DELETE = proxy;
const HEAD = proxy;
const OPTIONS = proxy;

void METHODS;
