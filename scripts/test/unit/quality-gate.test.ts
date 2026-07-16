import { expect, test } from 'bun:test';

import { qualityGateCommands } from '../../quality-gate/commands.ts';
import { runQualityGate } from '../../quality-gate/runner.ts';

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
