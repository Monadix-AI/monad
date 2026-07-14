import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkMigrationDrift } from '../../../scripts/check-migration-drift.ts';

const appRoot = join(import.meta.dir, '..', '..', '..');
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

test('migration drift check fails when the inline bundle is stale', async () => {
  const directory = await mkdtemp(join(appRoot, '.migration-bundle-'));
  temporaryDirectories.push(directory);
  const fixture = join(directory, 'migrations.generated.ts');
  await writeFile(fixture, `${await readFile(generatedModule, 'utf8')}// stale\n`);

  expect(() => checkMigrationDrift({ appRoot, generatedModule: fixture })).toThrow(
    'migrations.generated.ts is out of date'
  );
}, 30_000);
