#!/usr/bin/env bun

import { type QualityGateMode, qualityGateCommands } from './quality-gate/commands.ts';
import { runQualityGate } from './quality-gate/runner.ts';

const [rawMode, ...stagedFiles] = Bun.argv.slice(2);
const modes = new Set<QualityGateMode>(['check', 'fix', 'precommit']);

if (!rawMode || !modes.has(rawMode as QualityGateMode)) {
  process.stderr.write('usage: bun run scripts/quality-gate.ts <check|fix|precommit> [staged files...]\n');
  process.exit(2);
}

const mode = rawMode as QualityGateMode;
const result = await runQualityGate(qualityGateCommands(mode, stagedFiles));
if (result.failures.length > 0) {
  process.stderr.write(`\n[quality] failed: ${result.failures.map((command) => command.id).join(', ')}\n`);
} else {
  process.stdout.write('\n[quality] all checks passed\n');
}
process.exit(result.exitCode);
