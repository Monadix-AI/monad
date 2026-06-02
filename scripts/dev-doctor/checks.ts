import { existsSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';

import { parseEnvFile } from '../dev-init/env.ts';
import { worktreePortKeys } from '../dev-init/ports.ts';
import { isTcpPortAvailable } from '../dev-ports.ts';

export type DoctorStatus = 'error' | 'ok';

export interface DoctorResult {
  id: string;
  message: string;
  repair?: string;
  status: DoctorStatus;
}

export interface DevDoctorDeps {
  bunVersion: string;
  exists(path: string): Promise<boolean>;
  isPortAvailable(port: number): Promise<boolean>;
  portPids(port: string): string[];
  readText(path: string): Promise<string>;
  platform: NodeJS.Platform;
  which(command: string): string | null;
}

export function defaultDevDoctorDeps(): DevDoctorDeps {
  return {
    bunVersion: Bun.version,
    exists: async (path) => existsSync(path),
    isPortAvailable: isTcpPortAvailable,
    portPids: (port) => {
      if (process.platform === 'win32') return [];
      const result = Bun.spawnSync(['lsof', '-ti', `:${port}`], { stdout: 'pipe', stderr: 'pipe' });
      return result.stdout.toString().trim().split('\n').filter(Boolean);
    },
    platform: process.platform,
    readText: async (path) => Bun.file(path).text(),
    which: (command) => Bun.which(command)
  };
}

const ok = (id: string, message: string): DoctorResult => ({ id, message, status: 'ok' });
const error = (id: string, message: string, repair: string): DoctorResult => ({ id, message, repair, status: 'error' });

export async function runDevDoctor(
  root: string,
  deps: DevDoctorDeps = defaultDevDoctorDeps()
): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  const packagePath = join(root, 'package.json');
  const packageJson = JSON.parse(await deps.readText(packagePath)) as { packageManager?: string };
  const pinnedBun = packageJson.packageManager?.replace(/^bun@/, '') ?? '';

  results.push(
    deps.bunVersion === pinnedBun
      ? ok('bun-version', `Bun ${deps.bunVersion} matches package.json`)
      : error(
          'bun-version',
          `Bun ${deps.bunVersion} is active; this repository pins ${pinnedBun}`,
          `mise install bun@${pinnedBun}`
        )
  );

  results.push(
    (await deps.exists(join(root, 'node_modules')))
      ? ok('dependencies', 'Workspace dependencies are installed')
      : error('dependencies', 'Workspace dependencies are missing', 'bun install')
  );

  const envPath = join(root, '.env.local');
  const envExists = await deps.exists(envPath);
  results.push(
    envExists
      ? ok('environment', '.env.local is present')
      : error('environment', '.env.local is missing', 'mise run setup')
  );

  const shimPath = join(root, '.dev', 'bin', deps.platform === 'win32' ? 'monad.cmd' : 'monad');
  const shimExists = await deps.exists(shimPath);
  const shimText = shimExists ? await deps.readText(shimPath) : '';
  const shimEntrypoint =
    deps.platform === 'win32'
      ? win32.join(root, 'apps', 'cli', 'src', 'bin.ts')
      : posix.join(root, 'apps', 'cli', 'src', 'bin.ts');
  results.push(
    shimExists && shimText.includes(shimEntrypoint)
      ? ok('cli-shim', 'CLI shim points to this worktree')
      : error('cli-shim', 'CLI shim is missing or points to another worktree', 'mise run setup')
  );

  const generatedPaths = [
    join(root, 'packages', 'atoms', 'generated', 'codex-app-server'),
    join(root, 'apps', 'web', 'src', 'routeTree.gen.ts'),
    join(root, 'apps', 'monad', 'generated', 'licenses.json')
  ];
  const missingGenerated: string[] = [];
  for (const path of generatedPaths) {
    if (!(await deps.exists(path))) missingGenerated.push(path.slice(root.length + 1));
  }
  results.push(
    missingGenerated.length === 0
      ? ok('generated-artifacts', 'Required generated artifacts are present')
      : error('generated-artifacts', `Missing generated artifacts: ${missingGenerated.join(', ')}`, 'mise run setup')
  );

  if (!envExists) {
    results.push(error('ports', 'Configured ports cannot be checked without .env.local', 'mise run setup'));
  } else {
    const env = parseEnvFile(await deps.readText(envPath));
    const configured = worktreePortKeys
      .map((key) => ({ key, port: env.get(key) }))
      .filter((entry): entry is { key: (typeof worktreePortKeys)[number]; port: string } => Boolean(entry.port));
    const checks = await Promise.all(
      configured.map(async ({ key, port }) => ({
        available: await deps.isPortAvailable(Number(port)),
        key,
        port
      }))
    );
    const occupied = checks.find(({ available }) => !available);
    const occupiedPids = occupied ? deps.portPids(occupied.port) : [];
    results.push(
      occupied
        ? error(
            'ports',
            `${occupied.key} port ${occupied.port} is occupied${
              occupiedPids.length > 0 ? ` by PID ${occupiedPids.join(', ')}` : ''
            }`,
            'mise run dev:ports -- --rotate'
          )
        : ok('ports', 'Configured development ports are available')
    );
  }

  return results;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  const results = await runDevDoctor(root);

  for (const result of results) {
    const marker = result.status === 'ok' ? 'PASS' : 'FAIL';
    process.stdout.write(`[${marker}] ${result.message}\n`);
    if (result.repair) process.stdout.write(`       repair: ${result.repair}\n`);
  }

  process.exit(results.some((result) => result.status === 'error') ? 1 : 0);
}
