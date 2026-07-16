#!/usr/bin/env bun
import { join, resolve } from 'node:path';
import { $ } from 'bun';

const ROOT = resolve(import.meta.dir, '..');

await Promise.all([
  $`bun run ${join(ROOT, 'scripts/generate-codex-app-server-protocol.ts')}`,
  $`bun run ${join(ROOT, 'scripts/generate-avatar-styles.ts')}`,
  $`bun run ${join(ROOT, 'packages/environment/scripts/gen-config-schema.ts')}`,
  $`bun run ${join(ROOT, 'scripts/generate-licenses.ts')}`
]);
