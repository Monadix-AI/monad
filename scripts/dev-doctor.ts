#!/usr/bin/env bun

import { resolve } from 'node:path';

import { runDevDoctor } from './dev-doctor/checks.ts';

const root = resolve(import.meta.dir, '..');
const results = await runDevDoctor(root);

for (const result of results) {
  const marker = result.status === 'ok' ? 'PASS' : 'FAIL';
  process.stdout.write(`[${marker}] ${result.message}\n`);
  if (result.repair) process.stdout.write(`       repair: ${result.repair}\n`);
}

process.exit(results.some((result) => result.status === 'error') ? 1 : 0);
