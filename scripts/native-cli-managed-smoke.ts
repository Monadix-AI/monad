#!/usr/bin/env bun
/// <reference types="bun" />
import { resolveClientConn } from '@monad/home';

type Json = Record<string, unknown>;

function usage(): never {
  process.stderr.write(
    `${[
      'Usage:',
      '  bun run smoke:native-cli-managed -- --agent <name> --cwd <project-dir> [--server https://127.0.0.1:52749]',
      '',
      'This is an opt-in smoke test for already-installed provider CLIs.',
      'It does not install provider CLIs, perform provider login, or bypass provider-owned approvals.'
    ].join('\n')}\n`
  );
  process.exit(2);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function isLoopbackHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '::1' ||
        parsed.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

async function request<T extends Json>(server: string, path: string, init?: RequestInit): Promise<T> {
  const url = `${server}${path}`;
  const fetchOpts = {
    ...init,
    ...(isLoopbackHttpsUrl(url) ? { tls: { rejectUnauthorized: false } } : {})
  } as RequestInit & { tls?: { rejectUnauthorized: boolean } };
  const res = await fetch(url, fetchOpts);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  if (!res.ok) {
    const error = typeof data.error === 'string' ? data.error : text;
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status} ${error}`);
  }
  return data;
}

const agent = flag('agent') ?? usage();
const cwd = flag('cwd') ?? usage();
const server = flag('server') ?? Bun.env.MONAD_SERVER_URL ?? (await resolveClientConn()).baseUrl;

const session = await request<{ sessionId: string }>(server, '/v1/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    title: `Workplace: managed native CLI smoke (${agent})`,
    origin: {
      surface: 'web',
      client: 'native-cli-managed-smoke',
      transport: 'http',
      writableBy: ['http'],
      branchableBy: ['http']
    },
    cwd
  })
});

const current = await request<{ session: { origin?: { ext?: Json } } }>(server, `/v1/sessions/${session.sessionId}`);
const origin = {
  ...(current.session.origin ?? {}),
  ext: {
    ...(current.session.origin?.ext ?? {}),
    workplaceProjectMembers: [
      {
        type: 'native-cli',
        name: agent,
        settings: { managedProjectAgent: true }
      }
    ]
  }
};
await request(server, `/v1/sessions/${session.sessionId}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ agentId: null, origin })
});

await request(server, `/v1/projects/${session.sessionId}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    text: `Smoke test: ${agent}, acknowledge publicly with monad project post when ready.`
  })
});

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      sessionId: session.sessionId,
      agent,
      cwd,
      note: 'Open the Workplace Project and the native CLI diagnostics if provider login or approval is required.'
    },
    null,
    2
  )}\n`
);
