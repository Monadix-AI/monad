import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

interface HermesLifecycleProcess {
  exited: Promise<number>;
}

type HermesLifecycleSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'ignore';
    stdout: 'ignore';
    stderr: 'ignore';
  }
) => HermesLifecycleProcess;

export interface HermesLifecycleOptions {
  spawn?: HermesLifecycleSpawn;
}

export async function deleteHermesSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: HermesLifecycleOptions = {}
): Promise<void> {
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const proc = spawn(
    [context.agent.command, ...(context.agent.args ?? []), 'sessions', 'delete', context.providerSessionRef, '--yes'],
    {
      cwd: context.workingPath,
      env: { ...process.env, ...(context.agent.env ?? {}) },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`hermes sessions delete failed with exit code ${exitCode}`);
}
