import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export type CodeGraphInitResult =
  | { status: 'ready' }
  | { status: 'initialized' }
  | { status: 'unavailable' }
  | { status: 'failed'; detail: string };

export interface CodeGraphInitDeps {
  directoryExists(path: string): Promise<boolean>;
  run(command: string[], cwd: string): Promise<number>;
  which(command: string): string | null;
}

const defaultDeps: CodeGraphInitDeps = {
  directoryExists: async (path) =>
    await stat(path)
      .then((entry) => entry.isDirectory())
      .catch(() => false),
  run: async (command, cwd) => {
    const child = Bun.spawn(command, { cwd, stderr: 'inherit', stdout: 'inherit' });
    return await child.exited;
  },
  which: (command) => Bun.which(command)
};

export async function ensureCodeGraph(
  root: string,
  deps: CodeGraphInitDeps = defaultDeps
): Promise<CodeGraphInitResult> {
  if (await deps.directoryExists(join(root, '.codegraph'))) return { status: 'ready' };

  const executable = deps.which('codegraph');
  if (!executable) return { status: 'unavailable' };

  try {
    const exitCode = await deps.run([executable, 'init', root], root);
    return exitCode === 0 ? { status: 'initialized' } : { status: 'failed', detail: `exit code ${exitCode}` };
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
