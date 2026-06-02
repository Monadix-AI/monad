import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentModelOption } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';

export const CLAUDE_CODE_SUPPORTED_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];

interface ClaudeModelInfo {
  displayName: string;
  resolvedModel?: string;
  supportsFastMode?: boolean;
  value: string;
}

async function* pendingPrompt() {
  await new Promise<never>(() => {});
}

function displayName(model: { displayName: string; resolvedModel?: string }): string {
  if (!model.resolvedModel) return model.displayName;
  return `${model.displayName} (${model.resolvedModel})`;
}

export function claudeModelOptions(models: ClaudeModelInfo[]): MeshAgentModelOption[] {
  return models.map((model) => ({
    value: model.value,
    displayName: displayName(model),
    ...(model.supportsFastMode === true ? { speeds: ['fast'] } : {})
  }));
}

export async function listClaudeModelOptions(agent: MeshAgentView): Promise<MeshAgentModelOption[]> {
  const modelQuery = query({
    prompt: pendingPrompt(),
    options: {
      cwd: homedir(),
      env: { ...process.env, ...(agent.env ?? {}) },
      pathToClaudeCodeExecutable: agent.command
    }
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      modelQuery.close();
      reject(new Error('Claude Code model discovery timed out'));
    }, 10_000);
  });
  try {
    return claudeModelOptions(await Promise.race([modelQuery.supportedModels(), timedOut]));
  } finally {
    if (timeout) clearTimeout(timeout);
    modelQuery.close();
  }
}
