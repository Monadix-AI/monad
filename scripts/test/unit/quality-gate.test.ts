import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { qualityGateCommands } from '../../quality-gate/commands.ts';
import { runQualityGate } from '../../quality-gate/runner.ts';

const root = join(import.meta.dir, '..', '..', '..');

test('precommit is read-only and uses the canonical check list', () => {
  const commands = qualityGateCommands('precommit', ['apps/web/src/main.tsx']);

  expect(commands).toEqual(qualityGateCommands('check'));
  expect(commands.every((command) => command.phase === 'check' && !command.mutatesTrackedFiles)).toBe(true);
  expect(commands.filter((command) => command.id === 'knip')).toEqual([
    expect.objectContaining({ argv: ['bun', 'run', 'knip'], mutatesTrackedFiles: false, phase: 'check' })
  ]);
  expect(commands.flatMap((command) => command.argv)).not.toContain('--fix');
  expect(commands.flatMap((command) => command.argv)).not.toContain('--write');
});

test('check mode contains only read-only check commands and never runs generators', () => {
  const commands = qualityGateCommands('check');

  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every((command) => command.phase === 'check' && !command.mutatesTrackedFiles)).toBe(true);
  expect(commands.map((command) => command.id)).not.toContain('agents-sync');
  expect(commands.map((command) => command.id)).not.toContain('i18n-types');
  expect(commands.map((command) => command.id)).not.toContain('typecheck-prepare');
});

test('runner executes the complete gate and returns every failure', async () => {
  const commands = qualityGateCommands('check').slice(0, 3);
  const failingCommand = commands[1];
  if (!failingCommand) throw new Error('quality check fixture requires at least two commands');
  const visited: string[] = [];
  const result = await runQualityGate(commands, async (command) => {
    visited.push(command.id);
    return { exitCode: command.id === failingCommand.id ? 1 : 0 };
  });

  expect(visited).toEqual(commands.map((command) => command.id));
  expect(result.failures.map((command) => command.id)).toEqual([failingCommand.id]);
  expect(result.exitCode).toBe(1);
});

test('Lefthook and CI delegate to the shared quality-gate scripts', () => {
  const lefthook = readFileSync(join(root, 'lefthook.yml'), 'utf8');
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

  expect(lefthook).toContain('bun run quality:precommit');
  expect(lefthook).not.toContain('knip --fix');
  expect(lefthook).not.toContain('stage_fixed');
  expect(ci).toContain('bun run quality:check');
  expect(ci).toContain('git diff --exit-code');
});

test('typecheck preparation creates avatar styles before the license inventory imports them', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const prepare = packageJson.scripts['typecheck:prepare'] ?? '';

  expect(prepare.indexOf('generate-avatar-styles.ts')).toBeGreaterThanOrEqual(0);
  expect(prepare.indexOf('generate-avatar-styles.ts')).toBeLessThan(prepare.indexOf('generate-licenses.ts'));
});
