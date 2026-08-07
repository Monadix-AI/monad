import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { devCliShimText } from '../../dev-init/cli-shim.ts';
import { type CodeGraphInitDeps, ensureCodeGraph } from '../../dev-init/codegraph.ts';
import {
  ensurePortLines,
  nextAvailablePorts,
  portOffset,
  portsForOffset,
  removeBlankXdgLines,
  replacePortLines,
  worktreePorts
} from '../../dev-init/ports.ts';
import { syncTurboRemoteCache } from '../../dev-init/turbo-cache.ts';
import { findMainWorktreePath } from '../../dev-init/worktree.ts';

test('devCliShimText forwards POSIX arguments to the worktree CLI entry point', () => {
  expect(devCliShimText('/repo with space', 'darwin')).toBe(
    `#!/bin/sh\nexec bun '/repo with space/apps/cli/src/bin.ts' "$@"\n`
  );
});

test('devCliShimText forwards Windows arguments to the worktree CLI entry point', () => {
  expect(devCliShimText('C:\\repo', 'win32')).toBe('@echo off\r\nbun "C:\\repo\\apps\\cli\\src\\bin.ts" %*\r\n');
});

test('ensureCodeGraph initializes a missing worktree index with the discovered CLI', async () => {
  const calls: Array<{ command: string[]; cwd: string }> = [];
  const deps: CodeGraphInitDeps = {
    directoryExists: async () => false,
    run: async (command, cwd) => {
      calls.push({ command, cwd });
      return 0;
    },
    which: () => '/tools/codegraph'
  };

  const result = await ensureCodeGraph('/repo', deps);

  expect({ calls, result }).toEqual({
    calls: [{ command: ['/tools/codegraph', 'init', '/repo'], cwd: '/repo' }],
    result: { status: 'initialized' }
  });
});

test('ensureCodeGraph leaves an existing worktree index untouched', async () => {
  const calls: string[] = [];
  const result = await ensureCodeGraph('/repo', {
    directoryExists: async (path) => {
      calls.push(`directory:${path}`);
      return true;
    },
    run: async () => {
      calls.push('run');
      return 0;
    },
    which: (command) => {
      calls.push(`which:${command}`);
      return '/tools/codegraph';
    }
  });

  expect({ calls, result }).toEqual({
    calls: [`directory:${join('/repo', '.codegraph')}`],
    result: { status: 'ready' }
  });
});

test('ensureCodeGraph reports an unavailable CLI without attempting initialization', async () => {
  const calls: string[] = [];
  const result = await ensureCodeGraph('/repo', {
    directoryExists: async () => false,
    run: async () => {
      calls.push('run');
      return 0;
    },
    which: (command) => {
      calls.push(`which:${command}`);
      return null;
    }
  });

  expect({ calls, result }).toEqual({ calls: ['which:codegraph'], result: { status: 'unavailable' } });
});

test('mise owns worktree tool and environment activation', async () => {
  const root = new URL('../../../', import.meta.url);
  const packageJson = await Bun.file(new URL('package.json', root)).json();
  const miseConfig = await Bun.file(new URL('mise.toml', root)).text();
  const parsed = Bun.TOML.parse(miseConfig);
  const activationConfig = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'tasks'));

  expect(packageJson.scripts?.postinstall).toBe('bun run scripts/dev-init.ts --skip-generate');
  expect(activationConfig).toEqual({
    env: { _: { file: '.env.local', path: ['.dev/bin'] } },
    min_version: '2026.6.11',
    redactions: ['*_API_KEY', '*_PASSWORD', '*_SECRET', '*_TOKEN'],
    settings: {
      idiomatic_version_file_enable_tools: ['bun'],
      status: { show_tools: true }
    }
  });
});

test('findMainWorktreePath selects the checkout attached to main', async () => {
  const roots: string[] = [];
  const result = await findMainWorktreePath('/repo-feature', {
    listWorktrees: async (root) => {
      roots.push(root);
      return `worktree /repo
HEAD abc
branch refs/heads/main

worktree /repo-feature
HEAD def
branch refs/heads/codex/feature
`;
    }
  });

  expect({ result, roots }).toEqual({ result: '/repo', roots: ['/repo-feature'] });
});

test('syncTurboRemoteCache copies only the main worktree team binding', async () => {
  const writes: Array<{ path: string; text: string }> = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const result = await syncTurboRemoteCache('/repo-feature', logs.push.bind(logs), warnings.push.bind(warnings), {
    fileExists: async (path) => path === join('/repo', '.turbo', 'config.json'),
    findMainWorktree: async () => '/repo',
    readText: async () => '{"teamId":"team_123","token":"must-not-copy"}',
    writeText: async (path, text) => {
      writes.push({ path, text });
    }
  });

  expect({ logs, result, warnings, writes }).toEqual({
    logs: ['Turbo remote cache linked from main worktree'],
    result: 'copied',
    warnings: [],
    writes: [{ path: join('/repo-feature', '.turbo', 'config.json'), text: '{\n  "teamId": "team_123"\n}\n' }]
  });
});

test('syncTurboRemoteCache preserves an existing worktree binding', async () => {
  const calls: string[] = [];
  const result = await syncTurboRemoteCache(
    '/repo-feature',
    () => {},
    () => {},
    {
      fileExists: async (path) => {
        calls.push(`exists:${path}`);
        return true;
      },
      findMainWorktree: async () => {
        calls.push('find-main');
        return '/repo';
      },
      readText: async () => {
        calls.push('read');
        return '{}';
      },
      writeText: async () => {
        calls.push('write');
      }
    }
  );

  expect({ calls, result }).toEqual({
    calls: [`exists:${join('/repo-feature', '.turbo', 'config.json')}`],
    result: 'existing'
  });
});

test('portOffset is deterministic and within 0–999', () => {
  const a = portOffset('/Users/x/Projects/monad');
  expect(a).toBe(portOffset('/Users/x/Projects/monad')); // stable
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(1000);
});

test('different worktree paths get different ports', () => {
  const p1 = worktreePorts('/Users/x/Projects/monad');
  const p2 = worktreePorts('/Users/x/Projects/monad-feature');
  expect(p1.MONAD_PORT).not.toBe(p2.MONAD_PORT);
  expect(p1.MONAD_HTTP_PORT).not.toBe(p2.MONAD_HTTP_PORT);
  expect(p1.WEB_PORT).not.toBe(p2.WEB_PORT);
  expect(p1.WEB_STORYBOOK_PORT).not.toBe(p2.WEB_STORYBOOK_PORT);
  expect(p1.UI_STORYBOOK_PORT).not.toBe(p2.UI_STORYBOOK_PORT);
  expect(p1.MONAD_KV_UI_PORT).not.toBe(p2.MONAD_KV_UI_PORT);
  expect(p1.AI_SDK_DEVTOOLS_PORT).not.toBe(p2.AI_SDK_DEVTOOLS_PORT);
});

test('ports land in their documented non-overlapping ranges', () => {
  const p = worktreePorts('/some/worktree');
  expect(Number(p.MONAD_PORT)).toBeGreaterThanOrEqual(52000);
  expect(Number(p.MONAD_PORT)).toBeLessThan(53000);
  expect(Number(p.MONAD_HTTP_PORT)).toBeGreaterThanOrEqual(53000);
  expect(Number(p.MONAD_HTTP_PORT)).toBeLessThan(54000);
  expect(Number(p.WEB_PORT)).toBeGreaterThanOrEqual(3100);
  expect(Number(p.WEB_PORT)).toBeLessThan(4100);
  expect(Number(p.WEB_STORYBOOK_PORT)).toBeGreaterThanOrEqual(4100);
  expect(Number(p.WEB_STORYBOOK_PORT)).toBeLessThan(5100);
  expect(Number(p.UI_STORYBOOK_PORT)).toBeGreaterThanOrEqual(8400);
  expect(Number(p.UI_STORYBOOK_PORT)).toBeLessThan(9400);
  expect(Number(p.MONAD_KV_UI_PORT)).toBeGreaterThanOrEqual(6400);
  expect(Number(p.MONAD_KV_UI_PORT)).toBeLessThan(7400);
  expect(Number(p.AI_SDK_DEVTOOLS_PORT)).toBeGreaterThanOrEqual(7400);
  expect(Number(p.AI_SDK_DEVTOOLS_PORT)).toBeLessThan(8400);
});

test('ensurePortLines appends all ports to a file missing them', () => {
  const ports = worktreePorts('/wt');
  const { text, added } = ensurePortLines('MONAD_HOME=/wt/.dev/.monad\nOPENROUTER_API_KEY=sk\n', ports);
  expect(added).toEqual([
    `MONAD_PORT=${ports.MONAD_PORT}`,
    `MONAD_HTTP_PORT=${ports.MONAD_HTTP_PORT}`,
    `WEB_PORT=${ports.WEB_PORT}`,
    `WEB_STORYBOOK_PORT=${ports.WEB_STORYBOOK_PORT}`,
    `MONAD_KV_UI_PORT=${ports.MONAD_KV_UI_PORT}`,
    `AI_SDK_DEVTOOLS_PORT=${ports.AI_SDK_DEVTOOLS_PORT}`,
    `UI_STORYBOOK_PORT=${ports.UI_STORYBOOK_PORT}`
  ]);
  expect(text).toContain(`MONAD_PORT=${ports.MONAD_PORT}\n`);
});

test('ensurePortLines is idempotent — a second pass adds nothing and never duplicates', () => {
  const ports = worktreePorts('/wt');
  const first = ensurePortLines('MONAD_HOME=/wt\n', ports);
  const second = ensurePortLines(first.text, ports);
  expect((second.text.match(/^MONAD_PORT=/gm) ?? []).length).toBe(1);
});

test('ensurePortLines never clobbers a hand-set value', () => {
  const ports = worktreePorts('/wt');
  const { text, added } = ensurePortLines('WEB_PORT=9999\n', ports);
  expect(added).not.toContain(`WEB_PORT=${ports.WEB_PORT}`); // existing value respected
  expect(text).not.toContain(`WEB_PORT=${ports.WEB_PORT}`);
});

test('ensurePortLines treats a blank assignment as absent', () => {
  const ports = worktreePorts('/wt');
  const { added } = ensurePortLines('MONAD_PORT=\n', ports);
  expect(added).toContain(`MONAD_PORT=${ports.MONAD_PORT}`);
});

test('ensurePortLines inserts a newline before appending when the file lacks a trailing one', () => {
  const ports = worktreePorts('/wt');
  const { text } = ensurePortLines('MONAD_HOME=/wt', ports);
  expect(text.startsWith('MONAD_HOME=/wt\nMONAD_PORT=')).toBe(true);
});

test('replacePortLines rotates every managed port while preserving unrelated environment', () => {
  const text =
    'MONAD_HOME=/wt\nWEB_PORT=9999\n# keep this comment\nMONAD_PORT=59999\nWEB_PORT=9998\nOPENROUTER_API_KEY=sk\n';
  const ports = portsForOffset(42);

  expect(replacePortLines(text, ports)).toBe(
    `MONAD_HOME=/wt
# keep this comment
OPENROUTER_API_KEY=sk
MONAD_PORT=52042
MONAD_HTTP_PORT=53042
WEB_PORT=3142
WEB_STORYBOOK_PORT=4142
MONAD_KV_UI_PORT=6442
AI_SDK_DEVTOOLS_PORT=7442
UI_STORYBOOK_PORT=8442
`
  );
});

test('nextAvailablePorts skips a partially occupied port set', async () => {
  const checked: number[] = [];
  const result = await nextAvailablePorts(41, async (port) => {
    checked.push(port);
    return port !== 52042;
  });

  expect(result).toEqual({ offset: 43, ports: portsForOffset(43) });
  expect(checked).toEqual([
    ...Object.values(portsForOffset(42)).map(Number),
    ...Object.values(portsForOffset(43)).map(Number)
  ]);
});

test('removeBlankXdgLines removes empty optional XDG assignments', () => {
  const { text, removed } = removeBlankXdgLines('MONAD_HOME=/wt\nXDG_CACHE_HOME=\nXDG_DATA_HOME=""\nWEB_PORT=3000\n');
  expect(text).toBe('MONAD_HOME=/wt\nWEB_PORT=3000\n');
  expect(removed).toEqual(['XDG_CACHE_HOME', 'XDG_DATA_HOME']);
});

test('removeBlankXdgLines preserves real XDG overrides and comments', () => {
  const { text, removed } = removeBlankXdgLines('# XDG_CACHE_HOME=/tmp/cache\nXDG_CACHE_HOME=/tmp/cache\n');
  expect(text).toBe('# XDG_CACHE_HOME=/tmp/cache\nXDG_CACHE_HOME=/tmp/cache\n');
  expect(removed).toEqual([]);
});
