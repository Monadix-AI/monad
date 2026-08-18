import type { MeshAgentProviderSessionLifecycleContext } from '@monad/sdk-atom';

interface MonadLifecycleProcess {
  exited: Promise<number>;
}

type MonadLifecycleSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'ignore';
    stdout: 'ignore';
    stderr: 'ignore';
  }
) => MonadLifecycleProcess;

export interface MonadLifecycleOptions {
  spawn?: MonadLifecycleSpawn;
}

async function runMonadSessionLifecycle(
  context: MeshAgentProviderSessionLifecycleContext,
  action: 'archive' | 'unarchive' | 'rm',
  options: MonadLifecycleOptions
): Promise<void> {
  const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions));
  const proc = spawn(
    [context.agent.command, ...(context.agent.args ?? []), 'session', action, context.providerSessionRef],
    {
      cwd: context.workingPath,
      env: { ...process.env, ...(context.agent.env ?? {}) },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`monad session ${action} failed with exit code ${exitCode}`);
}

export function archiveMonadSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: MonadLifecycleOptions = {}
): Promise<void> {
  return runMonadSessionLifecycle(context, 'archive', options);
}

export function unarchiveMonadSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: MonadLifecycleOptions = {}
): Promise<void> {
  return runMonadSessionLifecycle(context, 'unarchive', options);
}

export async function deleteMonadSession(
  context: MeshAgentProviderSessionLifecycleContext,
  options: MonadLifecycleOptions = {}
): Promise<void> {
  await runMonadSessionLifecycle(context, 'rm', options);
}
