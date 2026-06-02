import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentModelOption } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function antigravityModelDisplayName(value: string): string | undefined {
  const gemini = /^gemini-(\d+(?:\.\d+)?)-(flash|pro)-(low|medium|high)$/i.exec(value);
  if (gemini) return `Gemini ${gemini[1]} ${titleCase(gemini[2] ?? '')} (${titleCase(gemini[3] ?? '')})`;

  const claude = /^claude-(sonnet|opus)-(\d+)-(\d+)(-thinking)?$/i.exec(value);
  if (claude) {
    const thinking = claude[4] ? ' (Thinking)' : '';
    return `Claude ${titleCase(claude[1] ?? '')} ${claude[2]}.${claude[3]}${thinking}`;
  }

  const gptOss = /^gpt-oss-(\d+)b-(low|medium|high)$/i.exec(value);
  if (gptOss) return `GPT-OSS ${gptOss[1]}B (${titleCase(gptOss[2] ?? '')})`;

  return undefined;
}

export function parseAntigravityModelOptions(output: string): MeshAgentModelOption[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[a-z0-9][a-z0-9._-]+$/i.test(line))
    )
  ].map((value) => {
    const displayName = antigravityModelDisplayName(value);
    return { value, ...(displayName ? { displayName } : {}) };
  });
}

export async function listAntigravityModelOptions(agent: MeshAgentView): Promise<MeshAgentModelOption[]> {
  const command = resolveBinary(agent.command, [], defaultBinProbes) ?? agent.command;
  const processHandle = Bun.spawn([command, 'models'], {
    cwd: homedir(),
    env: { ...process.env, ...(agent.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe'
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    processHandle.kill();
  }, MODEL_DISCOVERY_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited
    ]);
    if (timedOut) throw new Error('Antigravity model discovery timed out');
    if (exitCode !== 0) throw new Error(stderr.trim() || `Antigravity model discovery exited with code ${exitCode}`);
    const options = parseAntigravityModelOptions(stdout);
    if (options.length === 0) throw new Error('Antigravity model discovery returned no models');
    return options;
  } finally {
    clearTimeout(timeout);
  }
}
