import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentModelOption } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';
import { z } from 'zod';

export const GEMINI_SUPPORTED_MODEL_OPTIONS: MeshAgentModelOption[] = [
  { value: 'auto', displayName: 'Auto' },
  { value: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
  { value: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite' }
];
export const GEMINI_SUPPORTED_MODELS = GEMINI_SUPPORTED_MODEL_OPTIONS.map((option) => option.value);

const responseSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    result: z.unknown().optional(),
    error: z
      .object({
        message: z.string()
      })
      .catchall(z.unknown())
      .optional()
  })
  .catchall(z.unknown());

const sessionModelsSchema = z.object({
  models: z.object({
    availableModels: z.array(
      z.object({
        modelId: z.string().min(1),
        name: z.string().optional()
      })
    )
  })
});

export function geminiModelOptions(value: unknown): MeshAgentModelOption[] {
  const session = sessionModelsSchema.parse(value);
  return session.models.availableModels.map((model) => ({
    value: model.modelId,
    ...(model.name ? { displayName: model.name } : {})
  }));
}

async function writeRequest(
  stdin: { flush(): number | Promise<number>; write(data: string): number | Promise<number> },
  id: number,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  await stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  await stdin.flush();
}

async function listGeminiAcpModelOptions(agent: MeshAgentView): Promise<MeshAgentModelOption[]> {
  const command = resolveBinary(agent.command, [], defaultBinProbes) ?? agent.command;
  const processHandle = Bun.spawn([command, '--acp'], {
    cwd: homedir(),
    env: { ...process.env, ...(agent.env ?? {}) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore'
  });
  const reader = processHandle.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const timeout = setTimeout(() => processHandle.kill(), 10_000);

  const response = async (id: number): Promise<unknown> => {
    for (;;) {
      const boundary = pending.indexOf('\n');
      if (boundary >= 0) {
        const line = pending.slice(0, boundary).trim();
        pending = pending.slice(boundary + 1);
        if (!line.startsWith('{')) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = responseSchema.safeParse(value);
        if (!parsed.success || parsed.data.id !== id) continue;
        if (parsed.data.error) throw new Error(parsed.data.error.message);
        return parsed.data.result;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Gemini ACP exited before responding to request ${id}`);
      pending += decoder.decode(chunk.value, { stream: true });
    }
  };

  try {
    await writeRequest(processHandle.stdin, 1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'monad', version: '0.0.1' }
    });
    await response(1);
    await writeRequest(processHandle.stdin, 2, 'session/new', {
      cwd: homedir(),
      mcpServers: []
    });
    return geminiModelOptions(await response(2));
  } finally {
    clearTimeout(timeout);
    processHandle.stdin.end();
    processHandle.kill();
    await reader.cancel().catch(() => {});
    await processHandle.exited;
  }
}

function isGeminiCatalogUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authentication required|authentication failed|api key is missing|client is no longer supported|resource has been exhausted|quota/i.test(
    message
  );
}

export async function discoverGeminiModelOptions(agent: MeshAgentView): Promise<MeshAgentModelOption[]> {
  try {
    return await listGeminiAcpModelOptions(agent);
  } catch (error) {
    if (!isGeminiCatalogUnavailableError(error)) throw error;
    return GEMINI_SUPPORTED_MODEL_OPTIONS;
  }
}
