import type { MeshAgentTurnInput, MeshAgentView } from '@monad/protocol';
import type { MeshAgentSessionRuntimeContext, SessionEventRuntimeDefinition } from '@monad/sdk-atom';

import { hasFlag } from '../adapter-shared.ts';
import { SessionEventJsonlDriver } from '../session-event-jsonl-driver.ts';
import { parseCodexExecJsonl } from './exec-events.ts';

function codexTurnText(input: MeshAgentTurnInput): string {
  if (input.attachments.length === 0) return input.text;
  const references = input.attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join('\n');
  return `${input.text}\n\nAttachments available in the workspace:\n${references}`;
}

function codexExecOptions(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext
): { approvalArgs: string[]; execArgs: string[]; execGlobalArgs: string[] } {
  const approvalArgs: string[] = [];
  const args: string[] = [];
  const execGlobalArgs = ['--json', '--color', 'never'];
  const configuredArgs = agent.args ?? [];
  for (let index = 0; index < configuredArgs.length; index += 1) {
    const argument = configuredArgs[index];
    if (argument === undefined) continue;
    if (argument === '--ask-for-approval' || argument === '-a') {
      approvalArgs.push(argument);
      const value = configuredArgs[index + 1];
      if (value !== undefined) {
        approvalArgs.push(value);
        index += 1;
      }
    } else if (argument.startsWith('--ask-for-approval=') || argument.startsWith('-a=')) {
      approvalArgs.push(argument);
    } else {
      args.push(argument);
    }
  }
  const model = context.modelId ?? context.modelName;
  if (model && !hasFlag(args, '--model') && !hasFlag(args, '-m')) args.push('--model', model);
  if (context.reasoningEffort && !args.some((argument) => argument.startsWith('model_reasoning_effort'))) {
    args.push('-c', `model_reasoning_effort="${context.reasoningEffort}"`);
  }
  for (const path of context.extraWorkingPaths ?? []) execGlobalArgs.push('--add-dir', path);
  if (context.skipProviderApprovals && approvalArgs.length === 0) approvalArgs.push('--ask-for-approval', 'never');
  args.push(...(context.mcpConfigArgs ?? []));
  return { approvalArgs, execArgs: args, execGlobalArgs };
}

export function createCodexSessionRuntime(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  const { approvalArgs, execArgs, execGlobalArgs } = codexExecOptions(agent, context);
  const immutableText = context.startInput?.immutableInstructions?.text;
  return {
    plan: {
      processModel: 'per-turn',
      buildTurnLaunch: ({ providerSessionRef }) => {
        const instructionArgs =
          !providerSessionRef && immutableText ? ['-c', `developer_instructions=${JSON.stringify(immutableText)}`] : [];
        return {
          args: providerSessionRef
            ? [...approvalArgs, 'exec', ...execGlobalArgs, 'resume', ...execArgs, providerSessionRef, '-']
            : [...approvalArgs, 'exec', ...execGlobalArgs, ...instructionArgs, ...execArgs, '-'],
          cwd: context.workingPath,
          ...(context.env || agent.env ? { env: { ...(agent.env ?? {}), ...(context.env ?? {}) } } : {})
        };
      },
      encodeTurnInput: (input) => ({
        delivery: 'stdin',
        bytes: new TextEncoder().encode(codexTurnText(input))
      }),
      startup: { timeoutMs: 20_000 },
      continuation: { strategy: 'provider-session-ref' }
    },
    driver: new SessionEventJsonlDriver({ parseOutput: parseCodexExecJsonl })
  };
}
