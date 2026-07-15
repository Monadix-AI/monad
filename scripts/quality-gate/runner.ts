import type { QualityGateCommand } from './commands.ts';

export interface CommandResult {
  exitCode: number;
}

export interface QualityGateResult {
  exitCode: number;
  failures: QualityGateCommand[];
}

export type QualityGateExecutor = (command: QualityGateCommand) => Promise<CommandResult>;

export async function executeQualityGateCommand(command: QualityGateCommand): Promise<CommandResult> {
  process.stdout.write(`\n[quality] ${command.phase} ${command.label}\n`);
  try {
    const proc = Bun.spawn(command.argv, {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit'
    });
    return { exitCode: await proc.exited };
  } catch (error) {
    process.stderr.write(
      `[quality] unable to start ${command.id}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return { exitCode: 1 };
  }
}

export async function runQualityGate(
  commands: QualityGateCommand[],
  execute: QualityGateExecutor = executeQualityGateCommand
): Promise<QualityGateResult> {
  const failures: QualityGateCommand[] = [];
  for (const command of commands) {
    const result = await execute(command);
    if (result.exitCode !== 0) failures.push(command);
  }
  return { exitCode: failures.length === 0 ? 0 : 1, failures };
}
