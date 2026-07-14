import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { vmDir } from '../../src/toolchain.ts';

export function bundleMarker(agentId: string): string {
  return `agt:${agentId}#`.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function matchingProcessLines(processes: string, marker: string): string[] {
  return processes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(marker));
}

async function capture(argv: string[]): Promise<string> {
  const process = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]);
  if (code !== 0) throw new Error(`resource audit command failed: ${stderr.trim()}`);
  return stdout;
}

async function currentLeaks(agentId: string): Promise<string[]> {
  const marker = bundleMarker(agentId);
  const agentsDir = join(vmDir(), 'agents');
  const bundles = existsSync(agentsDir)
    ? (await readdir(agentsDir)).filter((name) => name.startsWith(marker)).map((name) => `bundle:${name}`)
    : [];
  if (process.platform === 'win32') {
    const vmName = `monad-${marker}*`;
    const script =
      `Get-VM -Name '${vmName}' -ErrorAction SilentlyContinue | ForEach-Object { 'vm:' + $_.Name }; ` +
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${marker}*' } | ` +
      `ForEach-Object { 'process:' + $_.ProcessId + ':' + $_.CommandLine }`;
    return [
      ...bundles,
      ...matchingProcessLines(await capture(['powershell', '-NoProfile', '-Command', script]), marker)
    ];
  }
  return [...bundles, ...matchingProcessLines(await capture(['ps', '-axo', 'pid=,command=']), marker)];
}

export async function waitForNoAgentResources(agentId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let leaks: string[] = [];
  do {
    leaks = await currentLeaks(agentId);
    if (leaks.length === 0) return;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`sandbox-vm leaked resources for ${bundleMarker(agentId)}: ${leaks.join('\n').slice(0, 8192)}`);
}
