import type { MeshAgentEventSource, MeshAgentProviderEventContext } from '@monad/sdk-atom';

import { createOutputEventSource } from '../event-source.ts';
import { monadObservationProjection } from './observation.ts';

type MonadHistoryOutputReader = (context: MeshAgentProviderEventContext) => string | null | Promise<string | null>;

function sessionAgentId(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as { agentIds?: unknown };
    return Array.isArray(parsed.agentIds)
      ? parsed.agentIds.find((agentId): agentId is string => typeof agentId === 'string' && agentId.length > 0)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readCommandOutput(argv: string[], cwd: string): Promise<string | null> {
  const proc = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? output : null;
}

async function replayAppServerEvents(context: MeshAgentProviderEventContext, agentId: string): Promise<string | null> {
  const proc = Bun.spawn(['monad', 'app-server'], {
    cwd: context.workingPath,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore'
  });
  const initialize = {
    kind: 'request',
    id: 'history-initialize',
    method: 'initialize',
    params: { protocolVersion: 1 }
  };
  const open = {
    kind: 'request',
    id: 'history-open',
    method: 'session/open',
    params: {
      agentId,
      cwd: context.workingPath,
      providerSessionRef: context.providerSessionRef
    }
  };
  proc.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(open)}\n`);
  proc.stdin.flush();

  const decoder = new TextDecoder();
  let output = '';
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  const hardTimer = setTimeout(() => proc.kill(), 5_000);
  try {
    for await (const chunk of proc.stdout) {
      output += decoder.decode(chunk, { stream: true });
      if (!output.includes('"method":"session/identified"')) continue;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => proc.kill(), 250);
    }
    output += decoder.decode();
  } finally {
    if (quietTimer) clearTimeout(quietTimer);
    clearTimeout(hardTimer);
    proc.kill();
    proc.stdin.end();
    await proc.exited;
  }

  const records = output.split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record.kind === 'notification' && record.method === 'session/event';
    } catch {
      return false;
    }
  });
  return records.length > 0 ? records.join('\n') : null;
}

export async function readMonadHistoryOutput(context: MeshAgentProviderEventContext): Promise<string | null> {
  const session = await readCommandOutput(
    ['monad', 'session', 'show', context.providerSessionRef, '--json'],
    context.workingPath
  );
  if (!session) return null;
  const agentId = sessionAgentId(session);
  if (!agentId) return null;
  return replayAppServerEvents(context, agentId);
}

export function createMonadEventSource(
  readOutput: MonadHistoryOutputReader = readMonadHistoryOutput
): MeshAgentEventSource {
  return createOutputEventSource({
    provider: 'monad',
    projection: monadObservationProjection,
    readOutput
  });
}
