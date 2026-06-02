import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

interface GeminiLifecycleProcess {
  exited: Promise<number>;
}

type GeminiLifecycleSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'ignore';
    stdout: 'ignore';
    stderr: 'ignore';
  }
) => GeminiLifecycleProcess;

export interface GeminiLifecycleOptions {
  command?: string;
  commandArgs?: string[];
  env?: Record<string, string | undefined>;
  spawn?: GeminiLifecycleSpawn;
}

export function archiveGeminiSession(
  _context: MeshAgentProviderSessionLifecycleContext,
  _options: GeminiLifecycleOptions = {}
): Promise<void> {
  // Gemini CLI exposes delete but no non-interactive archive equivalent today.
  return Promise.resolve();
}

export async function deleteGeminiSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: GeminiLifecycleOptions = {}
): Promise<void> {
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const proc = spawn(
    [options.command ?? 'gemini', ...(options.commandArgs ?? []), '--delete-session', context.providerSessionRef],
    {
      cwd: context.workingPath,
      env: { ...process.env, ...(options.env ?? {}) },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`gemini --delete-session failed with exit code ${exitCode}`);
}
