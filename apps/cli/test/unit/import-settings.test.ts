import { expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';

import { command as importCommand } from '../../src/commands/import.ts';
import { commands } from '../../src/commands/index.ts';
import { type CommandContext } from '../../src/commands/types.ts';
import { setOutputMode } from '../../src/lib/output.ts';

function ok<T>(data: T) {
  return { data, status: 200 };
}

function ctx(flags: Record<string, unknown>, client: unknown): CommandContext {
  return {
    positionals: ['settings'],
    flags,
    globals: { json: false, quiet: false, verbose: 0, yes: false, color: false },
    client: client as CommandContext['client']
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((chunk: string | Buffer) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return out;
  } finally {
    process.stdout.write = orig;
    setOutputMode({ format: 'human', color: false });
  }
}

function preview() {
  return {
    from: 'codex' as const,
    path: '/settings',
    warnings: [],
    items: [
      {
        id: 'mcpServers:remote',
        hash: 'hash-remote',
        category: 'mcpServers' as const,
        source: 'config.toml:mcp_servers.remote',
        target: 'remote',
        action: 'add' as const,
        reason: 'maps',
        risk: 'low' as const
      },
      {
        id: 'sandbox:sandbox.mode',
        hash: 'hash-sandbox',
        category: 'sandbox' as const,
        source: 'config.toml:sandbox_mode',
        target: 'sandbox.mode',
        action: 'add' as const,
        reason: 'maps sandbox',
        risk: 'high' as const
      }
    ]
  };
}

test('import command is registered with settings synopsis', () => {
  const command = commands.find((c) => c.name === 'import');
  expect(command?.synopsis).toContain('import settings');
  expect(command?.flags?.path?.type).toBe('string');
  expect(command?.flags?.apply?.type).toBe('boolean');
});

test('import command help metadata documents explicit-path and apply safety boundaries', () => {
  expect(importCommand.flags?.path?.description).toBe(
    'explicit local file or directory to read; no parent-dir, home-dir, or network scanning'
  );
  expect(importCommand.flags?.apply?.description).toBe(
    'write selected preview items; omitted means dry-run preview only'
  );
});

test('import settings defaults to dry-run preview', async () => {
  let previewBody: unknown;
  let applyCalled = false;
  const client = {
    treaty: {
      v1: {
        settings: {
          import: {
            preview: {
              post: async (body: unknown) => {
                previewBody = body;
                return ok(preview());
              }
            },
            apply: {
              post: async () => {
                applyCalled = true;
                return ok({ preview: preview(), applied: [], skipped: [] });
              }
            }
          }
        }
      }
    }
  };
  await captureStdout(() => importCommand.run(ctx({ path: '/settings', from: 'auto' }, client)));
  expect(previewBody).toEqual({ from: 'auto', path: '/settings', replace: false });
  expect(applyCalled).toBe(false);
});

test('import settings human output is grouped as a table', async () => {
  const client = {
    treaty: {
      v1: {
        settings: {
          import: {
            preview: { post: async () => ok(preview()) },
            apply: { post: async () => ok({ preview: preview(), applied: [], skipped: [] }) }
          }
        }
      }
    }
  };
  const output = await captureStdout(() => importCommand.run(ctx({ path: '/settings', from: 'codex' }, client)));
  expect(output).toContain('mcpServers (1)');
  expect(output).toContain('sandbox (1)');
  expect(output).toContain('id');
  expect(output).toContain('action');
  expect(output).toContain('target');
  expect(output).toContain('mcpServers:remote');
});

test('import settings --apply --select sends selected ids', async () => {
  let applyBody: unknown;
  const client = {
    treaty: {
      v1: {
        settings: {
          import: {
            preview: { post: async () => ok(preview()) },
            apply: {
              post: async (body: unknown) => {
                applyBody = body;
                return ok({ preview: preview(), applied: ['mcpServers:remote'], skipped: [] });
              }
            }
          }
        }
      }
    }
  };
  await captureStdout(() =>
    importCommand.run(
      ctx({ path: '/settings', from: 'codex', apply: true, select: 'mcpServers:remote', replace: true }, client)
    )
  );
  expect(applyBody).toEqual({
    from: 'codex',
    path: '/settings',
    replace: true,
    select: ['mcpServers:remote'],
    allSafe: false,
    hashes: { 'mcpServers:remote': 'hash-remote' }
  });
});

test('import settings --apply --all-safe sends allSafe without selected ids', async () => {
  let applyBody: unknown;
  const client = {
    treaty: {
      v1: {
        settings: {
          import: {
            preview: { post: async () => ok(preview()) },
            apply: {
              post: async (body: unknown) => {
                applyBody = body;
                return ok({ preview: preview(), applied: ['mcpServers:remote'], skipped: [] });
              }
            }
          }
        }
      }
    }
  };
  await captureStdout(() => importCommand.run(ctx({ path: '/settings', apply: true, 'all-safe': true }, client)));
  expect(applyBody).toEqual({
    from: 'auto',
    path: '/settings',
    replace: false,
    select: [],
    allSafe: true,
    hashes: { 'mcpServers:remote': 'hash-remote', 'sandbox:sandbox.mode': 'hash-sandbox' }
  });
});

test('import settings --json emits stable preview schema', async () => {
  const client = {
    treaty: {
      v1: {
        settings: {
          import: {
            preview: { post: async () => ok(preview()) },
            apply: { post: async () => ok({ preview: preview(), applied: [], skipped: [] }) }
          }
        }
      }
    }
  };
  const output = await captureStdout(async () => {
    setOutputMode({ format: 'json', color: false });
    await importCommand.run(ctx({ path: '/settings', from: 'codex' }, client));
  });
  expect(JSON.parse(output)).toEqual(preview());
});

test('import settings filters preview output and saves full preview', async () => {
  const file = `${import.meta.dir}/import-preview-${process.pid}-${Date.now()}.json`;
  const client = {
    treaty: {
      v1: {
        settings: {
          import: {
            preview: { post: async () => ok(preview()) },
            apply: { post: async () => ok({ preview: preview(), applied: [], skipped: [] }) }
          }
        }
      }
    }
  };
  const output = await captureStdout(async () => {
    setOutputMode({ format: 'json', color: false });
    await importCommand.run(ctx({ path: '/settings', only: 'mcpServers', risk: 'low', 'save-preview': file }, client));
  });
  expect(JSON.parse(output).items.map((i: { id: string }) => i.id)).toEqual(['mcpServers:remote']);
  expect(JSON.parse(await Bun.file(file).text()).items).toHaveLength(2);
  await unlink(file);
});

test('import doctor reports action and risk counts without applying', async () => {
  const client = {
    treaty: {
      v1: {
        settings: {
          import: {
            preview: { post: async () => ok(preview()) },
            apply: { post: async () => ok({ preview: preview(), applied: [], skipped: [] }) }
          }
        }
      }
    }
  };
  const output = await captureStdout(async () => {
    setOutputMode({ format: 'json', color: false });
    await importCommand.run({ ...ctx({ path: '/settings' }, client), positionals: ['doctor'] });
  });
  expect(JSON.parse(output)).toMatchObject({ from: 'codex', items: 2, risks: { low: 1, high: 1 } });
});
