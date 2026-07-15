import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseEnvFile } from '../dev-init/env.ts';

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
  portPids(port: string): string[];
  readText(path: string): Promise<string>;
  which(command: string): string | null;
}

export function defaultDevDoctorDeps(): DevDoctorDeps {
  return {
    bunVersion: Bun.version,
    exists: async (path) => existsSync(path),
    portPids: (port) => {
      if (process.platform === 'win32') return [];
      const result = Bun.spawnSync(['lsof', '-ti', `:${port}`], { stdout: 'pipe', stderr: 'pipe' });
      return result.stdout.toString().trim().split('\n').filter(Boolean);
    },
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
      : error('environment', '.env.local is missing', 'bun run setup')
  );

  const shimPath = join(root, '.dev', 'bin', process.platform === 'win32' ? 'monad.cmd' : 'monad');
  const shimExists = await deps.exists(shimPath);
  const shimText = shimExists ? await deps.readText(shimPath) : '';
  results.push(
    shimExists && shimText.includes(join(root, 'apps', 'cli', 'src', 'bin.ts'))
      ? ok('cli-shim', 'CLI shim points to this worktree')
      : error('cli-shim', 'CLI shim is missing or points to another worktree', 'bun run setup')
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
      : error('generated-artifacts', `Missing generated artifacts: ${missingGenerated.join(', ')}`, 'bun run setup')
  );

  if (!envExists) {
    results.push(error('ports', 'Configured ports cannot be checked without .env.local', 'bun run setup'));
  } else {
    const env = parseEnvFile(await deps.readText(envPath));
    const occupied = ['WEB_PORT', 'MONAD_PORT', 'MONAD_HTTP_PORT']
      .map((key) => env.get(key))
      .filter((port): port is string => Boolean(port))
      .sort()
      .map((port) => ({ pids: deps.portPids(port), port }))
      .find(({ pids }) => pids.length > 0);
    results.push(
      occupied
        ? error(
            'ports',
            `Configured port ${occupied.port} is occupied by PID ${occupied.pids.join(', ')}`,
            `lsof -nP -iTCP:${occupied.port} -sTCP:LISTEN`
          )
        : ok('ports', 'Configured development ports are available')
    );
  }

  return results;
}
