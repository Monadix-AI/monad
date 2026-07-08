import { expect, test } from 'bun:test';

import { command as mcp } from '../../src/commands/mcp.ts';
import { type CommandContext } from '../../src/commands/types.ts';

function ctx(positionals: string[], flags: Record<string, unknown>, client: unknown, yes = false): CommandContext {
  return {
    positionals,
    flags,
    globals: { json: false, quiet: false, verbose: 0, yes, color: false },
    client: client as CommandContext['client']
  };
}

async function silently(fn: () => Promise<void>): Promise<void> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
}

function ok<T>(data: T) {
  return { data, status: 200 };
}

function makeClient(
  mcpOverrides: Record<string, unknown> = {},
  settingsOverrides: Record<string, unknown> = {},
  byName: (args: { name: string }) => Record<string, unknown> = () => ({
    authorize: { post: async () => ok({ ok: true }) },
    reconnect: { post: async () => ok({ ok: true }) }
  })
) {
  const mcpBase = Object.assign(
    (_: unknown) => ({
      delete: async () => ok({}),
      enable: { post: async () => ok({}) },
      disable: { post: async () => ok({}) }
    }),
    {
      get: async () => ok({ servers: [] }),
      install: { post: async () => ok({ needsConsent: false, name: 'srv', warnings: [] }) },
      'install-binary': { post: async () => ok({ needsConsent: false, name: 'bin', warnings: [] }) }
    },
    mcpOverrides
  );

  return {
    treaty: {
      v1: {
        atoms: { mcp: mcpBase },
        settings: {
          'mcp-servers': Object.assign(byName, {
            status: { get: async () => ok({ servers: [] }) },
            registry: { search: { get: async () => ok({ entries: [] }) } },
            ...settingsOverrides
          })
        }
      }
    }
  };
}

// ── list ───────────────────────────────────────────────────────────────────────

test('mcp list: prints empty message when no servers', async () => {
  const client = makeClient();
  await silently(() => mcp.run(ctx([], {}, client)));
});

test('mcp list: prints server names and transports', async () => {
  const servers = [
    { name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] }
  ];
  const client = makeClient({ get: async () => ok({ servers }) });
  await silently(() => mcp.run(ctx(['list'], {}, client)));
});

test('mcp list: handles http transport server', async () => {
  const servers = [{ name: 'remote', transport: 'http', url: 'https://mcp.example.com' }];
  const client = makeClient({ get: async () => ok({ servers }) });
  await silently(() => mcp.run(ctx(['ls'], {}, client)));
});

// ── status ─────────────────────────────────────────────────────────────────────

test('mcp status: prints empty when no servers', async () => {
  const client = makeClient();
  await silently(() => mcp.run(ctx(['status'], {}, client)));
});

test('mcp status: shows connected server with tool count', async () => {
  const servers = [{ name: 'fs', state: 'connected', source: 'atom', transport: 'stdio', toolCount: 8 }];
  const client = makeClient({}, { status: { get: async () => ok({ servers }) } });
  await silently(() => mcp.run(ctx(['st'], {}, client)));
});

test('mcp status: shows failed server', async () => {
  const servers = [{ name: 'broken', state: 'failed', source: 'config', transport: 'stdio', toolCount: 0 }];
  const client = makeClient({}, { status: { get: async () => ok({ servers }) } });
  await silently(() => mcp.run(ctx(['status'], {}, client)));
});

// ── add (stdio) ────────────────────────────────────────────────────────────────

test('mcp add: installs stdio server', async () => {
  let capturedServer: unknown;
  const client = makeClient({
    install: {
      post: async (body: unknown) => {
        capturedServer = body;
        return ok({ needsConsent: false, name: 'fs', warnings: [] });
      }
    }
  });
  await silently(() => mcp.run(ctx(['add', 'fs', 'npx', '-y', '@mcp/server-filesystem'], {}, client)));
  expect((capturedServer as { server: { name: string } }).server.name).toBe('fs');
  expect((capturedServer as { server: { transport: string } }).server.transport).toBe('stdio');
});

test('mcp add: installs http server with --url', async () => {
  let capturedServer: unknown;
  const client = makeClient({
    install: {
      post: async (body: unknown) => {
        capturedServer = body;
        return ok({ needsConsent: false, name: 'remote', warnings: [] });
      }
    }
  });
  await silently(() => mcp.run(ctx(['add', 'remote', '--url', 'https://mcp.example.com'], {}, client)));
  expect((capturedServer as { server: { transport: string } }).server.transport).toBe('http');
  expect((capturedServer as { server: { url: string } }).server.url).toBe('https://mcp.example.com');
});

test('mcp add: shows consent prompt when install needs approval', async () => {
  const client = makeClient({
    install: { post: async () => ok({ needsConsent: true, name: 'risky', warnings: [] }) }
  });
  await silently(() => mcp.run(ctx(['add', 'risky', 'npx', 'risky-mcp'], {}, client)));
});

test('mcp add: shows usage when args are missing', async () => {
  const client = makeClient();
  await silently(() => mcp.run(ctx(['add'], {}, client)));
});

// ── add (binary / --release) ───────────────────────────────────────────────────

test('mcp add --release: installs binary from GitHub release', async () => {
  let capturedBody: unknown;
  const client = makeClient({
    'install-binary': {
      post: async (body: unknown) => {
        capturedBody = body;
        return ok({ needsConsent: false, name: 'my-mcp', warnings: [] });
      }
    }
  });
  await silently(() =>
    mcp.run(ctx(['add', 'my-mcp', '--release', 'owner/repo@v1.0.0', '--sha256', 'abc123'], {}, client))
  );
  expect((capturedBody as { owner: string }).owner).toBe('owner');
  expect((capturedBody as { repo: string }).repo).toBe('repo');
  expect((capturedBody as { tag: string }).tag).toBe('v1.0.0');
  expect((capturedBody as { sha256: string }).sha256).toBe('abc123');
});

test('mcp add --release: shows usage when release format is invalid', async () => {
  const client = makeClient();
  await silently(() => mcp.run(ctx(['add', 'my-mcp', '--release', 'bad-format'], {}, client)));
});

// ── remove ─────────────────────────────────────────────────────────────────────

test('mcp remove: deletes a named server', async () => {
  let deletedName: string | undefined;
  const client = {
    treaty: {
      v1: {
        atoms: {
          mcp: Object.assign(
            (args: { name: string }) => {
              deletedName = args.name;
              return { delete: async () => ok({}) };
            },
            {
              get: async () => ok({ servers: [] }),
              install: { post: async () => ok({ needsConsent: false, name: 'x', warnings: [] }) },
              'install-binary': { post: async () => ok({ needsConsent: false, name: 'x', warnings: [] }) }
            }
          )
        },
        settings: {
          'mcp-servers': {
            status: { get: async () => ok({ servers: [] }) },
            registry: { search: { get: async () => ok({ entries: [] }) } }
          }
        }
      }
    }
  };
  await silently(() => mcp.run(ctx(['remove', 'filesystem'], {}, client)));
  expect(deletedName).toBe('filesystem');
});

test('mcp remove: shows usage when name is missing', async () => {
  const client = makeClient();
  await silently(() => mcp.run(ctx(['rm'], {}, client)));
});

// ── search ─────────────────────────────────────────────────────────────────────

test('mcp search: displays results', async () => {
  const entries = [
    {
      name: 'filesystem',
      description: 'File system access',
      registry: 'mcp.run',
      transport: 'stdio',
      verified: true,
      command: 'npx',
      args: ['-y', '@mcp/fs'],
      env: []
    }
  ];
  const client = makeClient(
    {},
    { status: { get: async () => ok({ servers: [] }) }, registry: { search: { get: async () => ok({ entries }) } } }
  );
  await silently(() => mcp.run(ctx(['search', 'filesystem'], {}, client)));
});

test('mcp search: prints empty message when no results', async () => {
  const client = makeClient();
  await silently(() => mcp.run(ctx(['search', 'nonexistent-tool'], {}, client)));
});

test('mcp search: shows usage when query is empty', async () => {
  const client = makeClient();
  await silently(() => mcp.run(ctx(['search'], {}, client)));
});

// ── authorize ──────────────────────────────────────────────────────────────────

test('mcp authorize: hits the authorize endpoint for the named server', async () => {
  let authorizedName: string | undefined;
  const client = makeClient({}, {}, (args) => {
    authorizedName = args.name;
    return { authorize: { post: async () => ok({ ok: true }) } };
  });
  await silently(() => mcp.run(ctx(['authorize', 'linear'], {}, client)));
  expect(authorizedName).toBe('linear');
});

test('mcp authorize: aliases to auth', async () => {
  let authorizedName: string | undefined;
  const client = makeClient({}, {}, (args) => {
    authorizedName = args.name;
    return { authorize: { post: async () => ok({ ok: true }) } };
  });
  await silently(() => mcp.run(ctx(['auth', 'linear'], {}, client)));
  expect(authorizedName).toBe('linear');
});

test('mcp authorize: shows usage when name is missing', async () => {
  const client = makeClient();
  await silently(() => mcp.run(ctx(['authorize'], {}, client)));
});

test('mcp authorize: propagates a 404 for an unknown server', async () => {
  const client = makeClient({}, {}, () => ({ authorize: { post: async () => ({ data: null, status: 404 }) } }));
  await expect(silently(() => mcp.run(ctx(['authorize', 'nope'], {}, client)))).rejects.toThrow();
});

// ── reconnect ──────────────────────────────────────────────────────────────────

test('mcp reconnect: hits the reconnect endpoint for the named server', async () => {
  let reconnectedName: string | undefined;
  const client = makeClient({}, {}, (args) => {
    reconnectedName = args.name;
    return { reconnect: { post: async () => ok({ ok: true }) } };
  });
  await silently(() => mcp.run(ctx(['reconnect', 'linear'], {}, client)));
  expect(reconnectedName).toBe('linear');
});

test('mcp reconnect: shows usage when name is missing', async () => {
  const client = makeClient();
  await silently(() => mcp.run(ctx(['reconnect'], {}, client)));
});
