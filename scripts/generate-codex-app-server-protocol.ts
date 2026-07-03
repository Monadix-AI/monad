import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { $ } from 'bun';

const outDir = resolve(import.meta.dir, '../packages/protocol/vendor/codex-app-server');
const tsDir = join(outDir, 'ts');
const schemaDir = join(outDir, 'schema');

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
rmSync(tsDir, { recursive: true, force: true });
rmSync(schemaDir, { recursive: true, force: true });
mkdirSync(tsDir, { recursive: true });
mkdirSync(schemaDir, { recursive: true });

await $`codex app-server generate-ts --out ${tsDir}`;
await $`codex app-server generate-json-schema --out ${schemaDir}`;

process.stdout.write(`Generated Codex app-server protocol artifacts in ${outDir}\n`);
