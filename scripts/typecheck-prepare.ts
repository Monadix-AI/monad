#!/usr/bin/env bun
import { resolve } from 'node:path';
import { $ } from 'bun';

const ROOT = resolve(import.meta.dir, '..');

await Promise.all([
  $`bun run scripts/generate-dev-artifacts.ts`.cwd(ROOT),
  $`bun run --cwd apps/web generate:routes`.cwd(ROOT),
  $`bun run i18n:types`.cwd(ROOT)
]);
