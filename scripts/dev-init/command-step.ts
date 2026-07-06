import { buildDevStepProgressFrame, buildDevStepStatusFrame } from './output';

export async function runDevInitCommandStep(options: {
  color: boolean;
  command: string[];
  cwd?: string;
  doneVerb: string;
  label: string;
  target: string;
  verb: string;
}): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const tty = Boolean(process.stdout.isTTY);
  const spinnerFrames = ['-', '\\', '|', '/'];
  let spinnerIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  if (tty) {
    process.stdout.write(
      buildDevStepProgressFrame({
        color: options.color,
        frame: spinnerFrames[spinnerIndex] ?? '-',
        label: options.label,
        target: options.target,
        verb: options.verb
      })
    );
    spinnerTimer = setInterval(() => {
      spinnerIndex += 1;
      process.stdout.write(
        buildDevStepProgressFrame({
          color: options.color,
          frame: spinnerFrames[spinnerIndex % spinnerFrames.length] ?? '-',
          label: options.label,
          target: options.target,
          verb: options.verb
        })
      );
    }, 120);
  }
  const proc = Bun.spawn(options.command, {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (spinnerTimer) clearInterval(spinnerTimer);
  if (tty) process.stdout.write('\r\u001b[2K');
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (exitCode === 0) {
    process.stdout.write(
      buildDevStepStatusFrame({
        color: options.color,
        label: options.label,
        state: 'done',
        target: options.target,
        tty,
        verb: options.doneVerb
      })
    );
  }
  return { exitCode, stderr, stdout };
}
