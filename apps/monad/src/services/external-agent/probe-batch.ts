import type { ExternalAgentLaunchSpec } from '#/services/external-agent/types.ts';

const PROBE_TIMEOUT_MS = 2000;

export interface ExternalAgentProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type ExternalAgentProbeRunner = (launch: ExternalAgentLaunchSpec) => Promise<ExternalAgentProbeResult>;

export function externalAgentProbeKey(launch: ExternalAgentLaunchSpec): string {
  return JSON.stringify([
    launch.argv,
    launch.cwd,
    Object.entries(launch.env ?? {}).sort(([left], [right]) => left.localeCompare(right))
  ]);
}

export async function runExternalAgentProbe(launch: ExternalAgentLaunchSpec): Promise<ExternalAgentProbeResult> {
  const processHandle = Bun.spawn(launch.argv, {
    cwd: launch.cwd,
    env: { ...process.env, ...(launch.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe'
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    processHandle.kill();
  }, PROBE_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited
    ]);
    return { stdout, stderr, exitCode: timedOut ? null : exitCode };
  } finally {
    clearTimeout(timer);
  }
}

export async function runExternalAgentProbeBatch(
  launches: readonly ExternalAgentLaunchSpec[],
  runner: ExternalAgentProbeRunner = runExternalAgentProbe
): Promise<Map<string, ExternalAgentProbeResult | null>> {
  const executions = new Map<string, Promise<ExternalAgentProbeResult | null>>();
  for (const launch of launches) {
    const key = externalAgentProbeKey(launch);
    if (!executions.has(key))
      executions.set(
        key,
        runner(launch).catch(() => null)
      );
  }
  return new Map(await Promise.all([...executions].map(async ([key, result]) => [key, await result] as const)));
}
