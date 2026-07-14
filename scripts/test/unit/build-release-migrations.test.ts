import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const generatedModule = join(root, 'apps', 'monad', 'src', 'store', 'db', 'migrations.generated.ts');
const migrationsModule = join(root, 'apps', 'monad', 'src', 'store', 'db', 'migrations.ts');
const drizzleModule = join(root, 'apps', 'monad', 'node_modules', 'drizzle-orm', 'bun-sqlite', 'index.js');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test('release preparation regenerates the inline migration bundle', () => {
  const source = readFileSync(join(root, 'scripts', 'build-release.ts'), 'utf8');
  const generated = readFileSync(generatedModule, 'utf8');

  expect(source).toContain(
    "import { generateMigrationAssets } from '../apps/monad/scripts/generate-migration-assets.ts';"
  );
  expect(source).toContain('generateMigrationAssets();');
  expect(generated).toContain('export const MIGRATIONS: MigrationMeta[]');
  expect(generated).not.toContain("type: 'file'");
});

test('compiled migration smoke runs from a standalone binary without migration files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monad-migration-smoke-'));
  temporaryDirectories.push(directory);
  const entry = join(directory, 'entry.ts');
  const executable = join(directory, process.platform === 'win32' ? 'migration-smoke.exe' : 'migration-smoke');
  await writeFile(
    entry,
    [
      "import { Database } from 'bun:sqlite';",
      `import { drizzle } from ${JSON.stringify(drizzleModule)};`,
      `import { hasCurrentMigration, migrate } from ${JSON.stringify(migrationsModule)};`,
      "const sqlite = new Database(':memory:');",
      'migrate(drizzle(sqlite));',
      "if (!hasCurrentMigration(sqlite)) throw new Error('compiled migration history is not current');",
      "const sessions = sqlite.prepare(\"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'\").get();",
      "if (!sessions) throw new Error('compiled migration history did not create sessions');",
      "console.log('migration-smoke-ok');",
      ''
    ].join('\n')
  );

  const build = Bun.spawnSync([process.execPath, 'build', entry, '--compile', '--outfile', executable], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe'
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);

  await rm(entry);
  expect(await readdir(directory)).toEqual([basename(executable)]);

  const smoke = Bun.spawnSync([executable], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  expect(smoke.exitCode, smoke.stderr.toString()).toBe(0);
  expect(smoke.stdout.toString()).toContain('migration-smoke-ok');
}, 30_000);
