import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { renderMigrationAssets } from './generate-migration-assets.ts';

const DRIZZLE_KIT_VERSION = '0.31.4';

export interface MigrationDriftCheckOptions {
  appRoot?: string;
  generatedModule?: string;
  schemaPath?: string;
}

export function checkMigrationDrift(options: MigrationDriftCheckOptions = {}): void {
  const appRoot = resolve(options.appRoot ?? join(import.meta.dir, '..'));
  const drizzleDir = join(appRoot, 'drizzle');
  const generatedModule = resolve(
    options.generatedModule ?? join(appRoot, 'src', 'store', 'db', 'migrations.generated.ts')
  );
  const schemaPath = resolve(options.schemaPath ?? join(appRoot, 'src', 'store', 'db', 'schema.ts'));

  assertPinnedDrizzleKit(appRoot);
  assertGeneratedBundleIsCurrent(drizzleDir, generatedModule);
  assertMigrationArtifactsAreCurrent(appRoot, drizzleDir, schemaPath);
}

function assertPinnedDrizzleKit(appRoot: string): void {
  const packageJson = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const installedVersion = packageJson.devDependencies?.['drizzle-kit'];
  if (installedVersion !== DRIZZLE_KIT_VERSION) {
    throw new Error(`db:drift requires drizzle-kit ${DRIZZLE_KIT_VERSION}; found ${installedVersion ?? 'none'}`);
  }
  if (!existsSync(drizzleKitCli(appRoot))) {
    throw new Error(`db:drift requires the local drizzle-kit ${DRIZZLE_KIT_VERSION} installation`);
  }
}

function assertGeneratedBundleIsCurrent(drizzleDir: string, generatedModule: string): void {
  const expected = renderMigrationAssets(drizzleDir);
  if (!existsSync(generatedModule) || readFileSync(generatedModule, 'utf8') !== expected) {
    throw new Error('migrations.generated.ts is out of date; run bun run db:bundle');
  }
}

function assertMigrationArtifactsAreCurrent(appRoot: string, drizzleDir: string, schemaPath: string): void {
  const temporaryRoot = mkdtempSync(join(appRoot, '.drizzle-drift-'));
  const temporaryDrizzleDir = join(temporaryRoot, 'drizzle');
  try {
    cpSync(drizzleDir, temporaryDrizzleDir, { recursive: true });
    const before = readMigrationTree(temporaryDrizzleDir);
    const configPath = join(temporaryRoot, 'drizzle.config.ts');
    writeFileSync(configPath, renderTemporaryConfig(appRoot, schemaPath, temporaryDrizzleDir));

    const result = Bun.spawnSync([process.execPath, drizzleKitCli(appRoot), 'generate', `--config=${configPath}`], {
      cwd: appRoot,
      stderr: 'pipe',
      stdout: 'pipe'
    });
    if (result.exitCode !== 0 || result.stderr.toString().trim()) {
      throw new Error(`drizzle-kit generate failed:\n${formatOutput(result)}`);
    }

    const differences = diffMigrationTrees(before, readMigrationTree(temporaryDrizzleDir));
    if (differences.length > 0) {
      throw new Error(`Drizzle migration artifacts are out of date:\n${differences.join('\n')}`);
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function drizzleKitCli(appRoot: string): string {
  return join(appRoot, 'node_modules', 'drizzle-kit', 'bin.cjs');
}

function renderTemporaryConfig(appRoot: string, schemaPath: string, out: string): string {
  return [
    'export default {',
    "  dialect: 'sqlite',",
    `  schema: ${JSON.stringify(configPath(appRoot, schemaPath))},`,
    `  out: ${JSON.stringify(configPath(appRoot, out))}`,
    '};',
    ''
  ].join('\n');
}

function configPath(appRoot: string, path: string): string {
  return `./${relative(appRoot, path)}`;
}

function readMigrationTree(directory: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(directory, path), readFileSync(path));
  }
  return files;
}

function diffMigrationTrees(before: Map<string, Uint8Array>, after: Map<string, Uint8Array>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().flatMap((path) => {
    const previous = before.get(path);
    const next = after.get(path);
    if (!previous) return [`added ${path}`];
    if (!next) return [`removed ${path}`];
    return Buffer.from(previous).equals(Buffer.from(next)) ? [] : [`changed ${path}`];
  });
}

function formatOutput(result: ReturnType<typeof Bun.spawnSync>): string {
  return [result.stdout?.toString().trim(), result.stderr?.toString().trim()].filter(Boolean).join('\n');
}

if (import.meta.main) checkMigrationDrift();
