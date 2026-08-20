import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command as atom } from '../../src/commands/atom.ts';
import { type CommandContext, type LocalCommandContext } from '../../src/commands/types.ts';

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

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    treaty: {
      v1: {
        atoms: Object.assign(
          (_: unknown) => ({ delete: async () => ok({}) }),
          {
            get: async () => ok({ atomPacks: [] }),
            install: { post: async () => ok({ needsConsent: false, name: 'test-pack', atoms: [], warnings: [] }) },
            mcp: Object.assign((_: unknown) => ({ delete: async () => ok({}) }), {
              get: async () => ok({ servers: [] }),
              install: { post: async () => ok({ needsConsent: false, name: 'mcp-srv', warnings: [] }) },
              'install-binary': { post: async () => ok({ needsConsent: false, name: 'bin-srv', warnings: [] }) },
              enable: { post: async () => ok({}) },
              disable: { post: async () => ok({}) }
            })
          },
          overrides
        )
      }
    }
  };
}

// ── list ───────────────────────────────────────────────────────────────────────

test('atom list: prints empty message when no packs installed', async () => {
  const client = makeClient();
  await silently(() => atom.run(ctx([], {}, client)));
});

test('atom list: prints installed pack names and atom kinds', async () => {
  const packs = [
    { name: 'telegram-channel', displayName: 'Telegram', atoms: ['channel'], source: 'https://x.com', enabled: true }
  ];
  const client = makeClient({ get: async () => ok({ atomPacks: packs }) });
  await silently(() => atom.run(ctx(['list'], {}, client)));
});

test('atom list: shows disabled badge for disabled packs', async () => {
  const packs = [{ name: 'my-pack', displayName: '', atoms: ['tool'], source: null, enabled: false }];
  const client = makeClient({ get: async () => ok({ atomPacks: packs }) });
  await silently(() => atom.run(ctx(['ls'], {}, client)));
});

// ── install ────────────────────────────────────────────────────────────────────

test('atom install: installs a pack without consent prompt', async () => {
  let capturedSource: string | undefined;
  const client = makeClient({
    install: {
      post: async (body: { source: string; consent: boolean }) => {
        capturedSource = body.source;
        return ok({ needsConsent: false, name: 'my-pack', atoms: ['channel'], warnings: [] });
      }
    }
  });
  await silently(() => atom.run(ctx(['install', 'https://example.com/pack'], {}, client)));
  expect(capturedSource).toBe('https://example.com/pack');
});

test('atom install: shows consent prompt when pack needs approval', async () => {
  const client = makeClient({
    install: {
      post: async () => ok({ needsConsent: true, name: 'risky-pack', atoms: ['tool'], warnings: ['suspicious-api'] })
    }
  });
  await silently(() => atom.run(ctx(['add', 'local:./pack'], {}, client)));
});

test('atom install: shows warnings even when installation succeeds', async () => {
  const client = makeClient({
    install: {
      post: async () => ok({ needsConsent: false, name: 'warn-pack', atoms: ['channel'], warnings: ['net-access'] })
    }
  });
  await silently(() => atom.run(ctx(['install', 'local:./pack'], {}, client)));
});

test('atom install: throws when source is missing', async () => {
  const client = makeClient();
  await expect(silently(() => atom.run(ctx(['install'], {}, client)))).rejects.toThrow();
});

// ── remove ─────────────────────────────────────────────────────────────────────

test('atom remove: removes a named pack', async () => {
  let deletedName: string | undefined;
  const c = {
    treaty: {
      v1: {
        atoms: Object.assign(
          (args: { name: string }) => {
            deletedName = args.name;
            return { delete: async () => ok({}) };
          },
          {
            get: async () => ok({ atomPacks: [] }),
            install: { post: async () => ok({ needsConsent: false, name: 'x', atoms: [], warnings: [] }) }
          }
        )
      }
    }
  };
  await silently(() => atom.run(ctx(['remove', 'telegram-channel'], {}, c)));
  expect(deletedName).toBe('telegram-channel');
});

test('atom remove: throws when name is missing', async () => {
  const client = makeClient();
  await expect(silently(() => atom.run(ctx(['rm'], {}, client)))).rejects.toThrow();
});

// ── update ─────────────────────────────────────────────────────────────────────

test('atom update: checks eligible packs without changing them until confirmed', async () => {
  const checked: string[] = [];
  const packs = [
    { name: 'pack-a', source: 'github:x/a', atoms: ['channel'], enabled: true, canUpdate: true },
    { name: 'pack-b', atoms: ['tool'], enabled: true, canUpdate: false }
  ];
  const client = {
    treaty: {
      v1: {
        atoms: Object.assign(
          ({ name }: { name: string }) => ({
            update: {
              get: async () => {
                checked.push(name);
                return ok({ name, currentVersion: '1.0.0', latestVersion: '2.0.0', hasUpdate: true });
              }
            }
          }),
          {
            get: async () => ok({ atomPacks: packs })
          }
        )
      }
    }
  };
  await silently(() => atom.run(ctx(['update'], {}, client)));
  expect(checked).toEqual(['pack-a']);
});

test('atom update: confirms the checked specific pack with --yes', async () => {
  let confirmed: { body: unknown; name: string } | undefined;
  const packs = [{ name: 'specific', source: 'local:/tmp/s', atoms: ['tool'], enabled: true, canUpdate: true }];
  const client = {
    treaty: {
      v1: {
        atoms: Object.assign(
          ({ name }: { name: string }) => ({
            update: {
              get: async () =>
                ok({
                  name,
                  currentVersion: '1.0.0',
                  latestVersion: '2.0.0',
                  latestRevision: 'new-revision',
                  hasUpdate: true
                }),
              post: async (body: unknown) => {
                confirmed = { body, name };
                return ok({ name, atoms: ['tool'], warnings: [] });
              }
            }
          }),
          { get: async () => ok({ atomPacks: packs }) }
        )
      }
    }
  };
  await silently(() => atom.run(ctx(['up', 'specific'], {}, client, true)));
  expect(confirmed).toEqual({ name: 'specific', body: { confirm: true, revision: 'new-revision' } });
});

// ── scaffold ───────────────────────────────────────────────────────────────────

test('atom scaffold: creates channel skeleton in temp dir', async () => {
  const dir = join(tmpdir(), `monad-scaffold-test-${process.pid}`);
  const local: LocalCommandContext = {
    positionals: ['scaffold', 'myplatform', dir],
    flags: {},
    globals: { json: false, quiet: false, verbose: 0, yes: false, color: false }
  };
  await atom.runLocal?.(local);
  const { readFile, readdir } = await import('node:fs/promises');
  const packageJson = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
  const readme = await readFile(`${dir}/README.md`, 'utf8');
  expect(packageJson.scripts).toEqual({
    build: 'bun build ./atom-pack.ts --target=bun --outfile dist/atom-pack.js',
    pack: 'monad atom pack .'
  });
  expect(packageJson.devDependencies).toEqual({ '@monad/sdk-atom': 'workspace:*' });
  expect({ files: (await readdir(dir)).sort(), readme }).toEqual({
    files: ['README.md', 'atom-pack.json', 'atom-pack.ts', 'package.json'],
    readme: expect.stringContaining('git add atom-pack.json dist')
  });
  await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true }));
});

test('atom scaffold: throws on invalid type name', async () => {
  const client = makeClient();
  await expect(atom.run(ctx(['scaffold', 'InvalidType!'], {}, client))).rejects.toThrow();
});

test('atom scaffold: throws on unknown action', async () => {
  const client = makeClient();
  await expect(atom.run(ctx(['unknown-action'], {}, client))).rejects.toThrow();
});
