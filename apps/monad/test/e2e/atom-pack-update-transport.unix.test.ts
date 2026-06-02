import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome } from '@monad/environment';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, makeTestPaths, mockModel, stubModelDeps } from '../helpers.ts';

let baseDir: string;
let stagedDir: string;
let socketPath: string;
let tcp: ReturnType<typeof Bun.serve> | undefined;
let unix: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  baseDir = join(tmpdir(), `monad-atom-update-transport-${process.pid}-${Date.now()}`);
  stagedDir = join(baseDir, 'staged');
  socketPath = join(baseDir, 'daemon.sock');
  const paths = makeTestPaths(baseDir);
  await initMonadHome(paths);
  await mkdir(join(stagedDir, 'dist'), { recursive: true });
  await writeFile(
    join(stagedDir, 'atom-pack.json'),
    JSON.stringify({ name: 'wa', version: '1.0.0', sdkVersion: '0', atoms: [], entry: 'dist/atom-pack.js' })
  );
  await writeFile(join(stagedDir, 'dist', 'atom-pack.js'), 'export default {};');

  const app = createHttpTransport(buildHandlers(mockModel(), { ...stubModelDeps(), paths }));
  const handler = (request: Request) => app.handle(request);
  tcp = Bun.serve({ port: 0, fetch: handler });
  unix = Bun.serve({ unix: socketPath, fetch: handler });
});

afterAll(async () => {
  tcp?.stop(true);
  unix?.stop(true);
  await rm(baseDir, { recursive: true, force: true });
});

async function post(url: string, unixSocket?: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(unixSocket ? { unix: unixSocket } : {})
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function get(url: string, unixSocket?: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...(unixSocket ? { unix: unixSocket } : {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('Atom Pack update has the same successful contract over TCP and Unix socket transports', async () => {
  if (!tcp || !unix) throw new Error('transports did not start');
  const tcpBase = `http://127.0.0.1:${tcp.port}`;
  await post(`${tcpBase}/v1/atoms/install`, undefined, { source: `local:${stagedDir}`, consent: true });
  await writeFile(
    join(stagedDir, 'atom-pack.json'),
    JSON.stringify({ name: 'wa', version: '2.0.0', sdkVersion: '0', atoms: [], entry: 'dist/atom-pack.js' })
  );

  const tcpCheck = await get(`${tcpBase}/v1/atoms/wa/update`);
  const unixCheck = await get('http://localhost/v1/atoms/wa/update', socketPath);
  const revision = (tcpCheck.body as { latestRevision: string }).latestRevision;
  const tcpResult = await post(`${tcpBase}/v1/atoms/wa/update`, undefined, { confirm: true, revision });
  const unixResult = await post('http://localhost/v1/atoms/wa/update', socketPath, { confirm: true, revision });

  expect(tcpCheck).toEqual(unixCheck);
  expect({ tcp: tcpResult, unix: unixResult }).toEqual({
    tcp: { status: 200, body: { name: 'wa', atoms: [], warnings: [] } },
    unix: { status: 200, body: { name: 'wa', atoms: [], warnings: [] } }
  });
});
