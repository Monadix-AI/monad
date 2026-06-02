import { afterEach, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkMigrationDrift } from '../../../scripts/check-migration-drift.ts';
import { renderMigrationAssets } from '../../../scripts/generate-migration-assets.ts';

const appRoot = join(import.meta.dir, '..', '..', '..');
const drizzleDir = join(appRoot, 'drizzle');
const schemaPath = join(appRoot, 'src', 'store', 'db', 'schema.ts');
const generatedModule = join(appRoot, 'src', 'store', 'db', 'migrations.generated.ts');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test('migration drift check passes when committed schema, history, and bundle are synchronized', () => {
  expect(() => checkMigrationDrift({ appRoot })).not.toThrow();
}, 30_000);

test('migration drift check fails when a schema fixture needs a new migration', async () => {
  const directory = await mkdtemp(join(appRoot, '.migration-drift-'));
  temporaryDirectories.push(directory);
  const fixture = join(directory, 'schema.ts');
  const schema = await readFile(schemaPath, 'utf8');
  await writeFile(
    fixture,
    `${schema}\nexport const migrationDriftFixture = sqliteTable('migration_drift_fixture', { id: text('id').primaryKey() });\n`
  );

  expect(() => checkMigrationDrift({ appRoot, schemaPath: fixture })).toThrow(
    'Drizzle migration artifacts are out of date'
  );
}, 30_000);

test('migration drift check classifies a non-interactive rename prompt as schema drift', async () => {
  const directory = await mkdtemp(join(appRoot, '.migration-rename-'));
  temporaryDirectories.push(directory);
  const fixture = join(directory, 'schema.ts');
  const schema = await readFile(schemaPath, 'utf8');
  const renamedSchema = schema.replace("'sessions',", "'renamed_sessions',");
  expect(renamedSchema).not.toBe(schema);
  await writeFile(fixture, renamedSchema);

  expect(() => checkMigrationDrift({ appRoot, schemaPath: fixture })).toThrow(
    /Drizzle migration generation did not confirm no schema changes; interactive rename input is required[\s\S]*Interactive prompts require a TTY/
  );
}, 30_000);

test('migration drift check fails when the inline bundle is stale', async () => {
  const directory = await mkdtemp(join(appRoot, '.migration-bundle-'));
  temporaryDirectories.push(directory);
  const fixture = join(directory, 'migrations.generated.ts');
  await writeFile(fixture, `${await readFile(generatedModule, 'utf8')}// stale\n`);

  expect(() => checkMigrationDrift({ appRoot, generatedModule: fixture })).toThrow(
    'migrations.generated.ts is out of date'
  );
}, 30_000);

test('migration asset generation rejects an orphan top-level SQL file', async () => {
  const directory = await mkdtemp(join(appRoot, '.migration-orphan-'));
  temporaryDirectories.push(directory);
  const fixture = join(directory, 'drizzle');
  await cp(drizzleDir, fixture, { recursive: true });
  await writeFile(join(fixture, '9999_orphan.sql'), 'SELECT 1;\n');

  expect(() => renderMigrationAssets(fixture)).toThrow('Drizzle migration SQL file has no journal entry: 9999_orphan');
});

test('migration asset generation rejects duplicate journal tags', async () => {
  const directory = await mkdtemp(join(appRoot, '.migration-duplicate-'));
  temporaryDirectories.push(directory);
  const fixture = join(directory, 'drizzle');
  await cp(drizzleDir, fixture, { recursive: true });
  const journalPath = join(fixture, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] };
  const first = journal.entries[0];
  if (!first) throw new Error('fixture journal has no entries');
  journal.entries.push(first);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  expect(() => renderMigrationAssets(fixture)).toThrow('Drizzle journal contains duplicate migration tag');
});
