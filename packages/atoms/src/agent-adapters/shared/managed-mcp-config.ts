import type { NativeAgentManagedMcpServer } from '@monad/protocol';

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Host-side command boundary shared by adapters with managed MCP configuration. */
export interface ManagedMcpConfigCommand {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export type ManagedMcpConfigRunner = (command: ManagedMcpConfigCommand) => {
  exitCode: number;
  stderr: string;
};

export const runManagedMcpConfigCommand: ManagedMcpConfigRunner = ({ argv, cwd, env }) => {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'pipe'
  });
  return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
};

export function requireManagedMcpConfigCommand(
  provider: string,
  command: ManagedMcpConfigCommand,
  run: ManagedMcpConfigRunner
): void {
  const result = run(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `${provider} managed MCP configuration failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
}

export function copyManagedConfigFile(source: string, target: string, emptyConfig: string): void {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(source)) copyFileSync(source, target);
  else writeFileSync(target, emptyConfig, { mode: 0o600 });
  chmodSync(target, 0o600);
}

export function writeManagedMcpConfigFile(
  path: string,
  server: NativeAgentManagedMcpServer,
  options: { root?: Record<string, unknown>; server?: Record<string, unknown> } = {}
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        ...(options.root ?? {}),
        mcpServers: {
          [server.name]: {
            command: server.command,
            args: server.args,
            env: server.env,
            ...(options.server ?? {})
          }
        }
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

export function mirrorManagedConfigHome(
  source: string,
  target: string,
  configName: string,
  emptyConfig: string,
  options: { preserveExisting?: boolean } = {}
): void {
  if (!options.preserveExisting) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  if (existsSync(source)) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = join(source, entry.name);
      const targetPath = join(target, entry.name);
      if (options.preserveExisting && existsSync(targetPath)) continue;
      if (entry.name === configName) {
        copyFileSync(sourcePath, targetPath);
        continue;
      }
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const targetStat = statSync(sourcePath);
          isDirectory = targetStat.isDirectory();
          isFile = targetStat.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) symlinkSync(sourcePath, targetPath, 'junction');
      else if (isFile) copyFileSync(sourcePath, targetPath);
    }
  }
  const configPath = join(target, configName);
  try {
    writeFileSync(configPath, emptyConfig, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  chmodSync(configPath, 0o600);
}
