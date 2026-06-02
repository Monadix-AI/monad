import type { MeshAgentProviderEventContext } from '@monad/sdk-atom';

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

async function parsedJsonFile(path: string): Promise<unknown> {
  try {
    return z.json().parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
}

function openClawAgentId(providerSessionRef: string): string | undefined {
  const agentId = /^agent:([^:]+):/.exec(providerSessionRef)?.[1];
  return agentId && /^[A-Za-z0-9_-]+$/.test(agentId) ? agentId : undefined;
}

export async function openClawHistoryRecords(context: MeshAgentProviderEventContext): Promise<JsonRecord[] | null> {
  const agentId = openClawAgentId(context.providerSessionRef);
  if (!agentId) return null;
  const stateRoot = context.env?.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw');
  const sessionsDir = join(stateRoot, 'agents', agentId, 'sessions');
  const index = jsonRecord(await parsedJsonFile(join(sessionsDir, 'sessions.json')));
  const session = jsonRecord(index?.[context.providerSessionRef]);
  const sessionId = session?.sessionId;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  let output: string;
  try {
    output = await readFile(join(sessionsDir, `${sessionId}.jsonl`), 'utf8');
  } catch {
    return null;
  }
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = jsonRecord(z.json().parse(JSON.parse(line)));
        return record?.type === 'message' && jsonRecord(record.message) ? [record] : [];
      } catch {
        return [];
      }
    });
}
