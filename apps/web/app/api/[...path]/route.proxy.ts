import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveDaemonUrl } from '@monad/home';

import { loopbackTlsOptions } from '@/lib/loopback-tls';
import { proxyResponseBody } from '@/lib/proxy-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

function daemonUrlFromConfig(raw: string): string | null {
  const network = (JSON.parse(raw) as { network?: Parameters<typeof resolveDaemonUrl>[0]['network'] })?.network;
  if (!network?.port) return null;
  return resolveDaemonUrl({ network, env: process.env });
}

function readDaemonUrl(): string {
  if (process.env.MONAD_URL) return resolveDaemonUrl({ env: process.env });

  const configPaths = [
    process.env.MONAD_HOME ? join(process.env.MONAD_HOME, 'configs', 'config.json') : undefined,
    resolve(process.cwd(), '../..', '.dev', '.monad', 'configs', 'config.json')
  ].filter((path): path is string => !!path);

  for (const configPath of configPaths) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const url = daemonUrlFromConfig(raw);
      if (url) return url;
    } catch {}
  }

  try {
    const raw = readFileSync(join(process.env.HOME ?? '', '.monad', 'configs', 'config.json'), 'utf-8');
    const url = daemonUrlFromConfig(raw);
    if (url) return url;
  } catch {}

  return resolveDaemonUrl({ env: process.env });
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
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      ...loopbackTlsOptions(daemon)
    } as RequestInit & { tls?: { rejectUnauthorized: boolean } });
    const resHeaders = new Headers(upstream.headers);
    resHeaders.delete('transfer-encoding');
    return new Response(proxyResponseBody(upstream), { status: upstream.status, headers: resHeaders });
  } catch {
    return new Response('Bad Gateway', { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;

void METHODS;
