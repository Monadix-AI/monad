import type { NativeAgentRuntimePromptInput, NativeAgentRuntimeSpec, NativeCliLaunchMode } from '@monad/protocol';

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { getNativeCliProviderAdapter } from '@/services/native-cli/index.ts';
import managedProjectRuntimeMcpPromptPath from './prompts/managed-project-runtime-mcp-prompt.md' with { type: 'file' };
import managedProjectRuntimePromptPath from './prompts/managed-project-runtime-prompt.md' with { type: 'file' };

const MANAGED_PROJECT_RUNTIME_PROMPT = (await Bun.file(managedProjectRuntimePromptPath).text()).trim();
const MANAGED_PROJECT_RUNTIME_MCP_PROMPT = (await Bun.file(managedProjectRuntimeMcpPromptPath).text()).trim();

function buildManagedProjectPrompt(args: NativeAgentRuntimePromptInput): string {
  const runtimeMetadata = [
    `Agent name: ${args.agentName}`,
    ...(args.displayName ? [`Display name: ${args.displayName}`] : []),
    ...(args.displayName ? ['Display name is your project communication name.'] : []),
    'Agent name is an internal API/runtime id for Monad CLI calls only.',
    `Project id: ${args.projectId}`,
    `Native CLI session id: ${args.nativeCliSessionId}`,
    `Provider: ${args.provider}`,
    `Workspace: ${args.workspace}`,
    ...((args.modelId ?? args.modelName) ? [`Requested model: ${args.modelId ?? args.modelName}`] : []),
    ...(args.reasoningEffort ? [`Requested reasoning effort: ${args.reasoningEffort}`] : []),
    ...(args.speed ? [`Requested speed: ${args.speed}`] : [])
  ].join('\n');
  const customPromptBlock = args.customPrompt
    ? ['Project instance custom prompt:', args.customPrompt, ''].join('\n')
    : '';
  const usesMcpBridge = getNativeCliProviderAdapter(args.provider).managedRuntime?.usesManagedMcpBridge ?? false;
  const template = usesMcpBridge ? MANAGED_PROJECT_RUNTIME_MCP_PROMPT : MANAGED_PROJECT_RUNTIME_PROMPT;
  return template.replace('{{runtimeMetadata}}', runtimeMetadata).replace('{{customPromptBlock}}', customPromptBlock);
}

function hashManagedAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function buildManagedProjectCliWrapperScript(
  cliSourceEntry: string | null,
  executablePath = process.execPath,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return cliSourceEntry ? `@echo off\r\nbun "${cliSourceEntry}" %*\r\n` : `@echo off\r\n"${executablePath}" %*\r\n`;
  }
  return cliSourceEntry
    ? `#!/usr/bin/env sh\nexec bun "${cliSourceEntry}" "$@"\n`
    : `#!/usr/bin/env sh\nexec "${executablePath}" "$@"\n`;
}

export function managedProjectCliWrapperName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'monad.cmd' : 'monad';
}

export function managedProjectLaunchMode(
  agent: Pick<NativeAgentRuntimePromptInput, 'provider'> & { defaultLaunchMode: NativeCliLaunchMode },
  requested?: NativeCliLaunchMode
): NativeCliLaunchMode {
  if (requested && requested !== 'pty') return requested;
  const managed = getNativeCliProviderAdapter(agent.provider).managedRuntime;
  return managed?.launchMode?.(agent.defaultLaunchMode) ?? requested ?? agent.defaultLaunchMode;
}

export function cleanupManagedProjectRuntimeToken(workspace: string): void {
  try {
    unlinkSync(join(workspace, '.monad-agent-token'));
  } catch {
    /* token already absent */
  }
}

export function cleanupManagedProjectOrphanTokens(monadHome: string): number {
  const root = join(monadHome, 'workplace-agents');
  if (!existsSync(root)) return 0;
  let removed = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry === '.monad-agent-token') {
        try {
          unlinkSync(path);
          removed += 1;
        } catch {
          /* token already absent */
        }
        continue;
      }
      try {
        const stat = lstatSync(path);
        if (!stat.isSymbolicLink() && stat.isDirectory()) visit(path);
      } catch {
        /* ignore races with concurrent cleanup */
      }
    }
  };
  visit(root);
  return removed;
}

function assertManagedWorkspaceContained(root: string, workspace: string): void {
  const relativeWorkspace = relative(root, workspace);
  if (relativeWorkspace === '' || relativeWorkspace.startsWith('..') || isAbsolute(relativeWorkspace)) {
    throw new Error('managed native CLI workspace must stay inside the project agent root');
  }
}

export function managedProjectRuntimeWorkspace(args: {
  monadHome: string;
  projectId: string;
  agentName: string;
}): string {
  const projectAgentRoot = resolve(args.monadHome, 'workplace-agents', args.projectId);
  const workspace = resolve(projectAgentRoot, args.agentName);
  assertManagedWorkspaceContained(projectAgentRoot, workspace);
  return workspace;
}

export function prepareManagedProjectRuntime(
  args: {
    monadHome: string;
    serverUrl: string;
    baseEnvPath?: string;
    platform?: NodeJS.Platform;
  } & Omit<NativeAgentRuntimePromptInput, 'workspace'>
): NativeAgentRuntimeSpec {
  const platform = args.platform ?? process.platform;
  const workspace = managedProjectRuntimeWorkspace(args);
  const binDir = join(workspace, 'bin');
  mkdirSync(binDir, { recursive: true });
  const prompt = buildManagedProjectPrompt({
    agentName: args.agentName,
    ...(args.displayName ? { displayName: args.displayName } : {}),
    projectId: args.projectId,
    nativeCliSessionId: args.nativeCliSessionId,
    provider: args.provider,
    workspace,
    ...(args.modelName ? { modelName: args.modelName } : {}),
    ...(args.modelId ? { modelId: args.modelId } : {}),
    ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    ...(args.speed ? { speed: args.speed } : {}),
    ...(args.customPrompt ? { customPrompt: args.customPrompt } : {})
  });
  const promptFile = join(workspace, 'managed-prompt.md');
  const memoryFile = join(workspace, 'MEMORY.md');
  const tokenFile = join(workspace, '.monad-agent-token');
  const token = randomBytes(32).toString('hex');
  const wrapperBin = join(binDir, managedProjectCliWrapperName(platform));
  const cliSourceEntry = join(import.meta.dir, '../../../../cli/src/main.ts');
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  cleanupManagedProjectRuntimeToken(workspace);
  writeFileSync(tokenFile, token, { mode: 0o600 });
  if (!existsSync(memoryFile)) {
    writeFileSync(
      memoryFile,
      `# ${args.agentName} managed project memory\n\nUse this file for durable notes that help restore project context.\n`,
      { mode: 0o600 }
    );
  }
  writeFileSync(
    wrapperBin,
    buildManagedProjectCliWrapperScript(existsSync(cliSourceEntry) ? cliSourceEntry : null, process.execPath, platform),
    {
      mode: 0o755
    }
  );
  const managed = getNativeCliProviderAdapter(args.provider).managedRuntime;
  const env = {
    ...(managed?.env?.() ?? {}),
    MONAD_HOME: args.monadHome,
    MONAD_NATIVE_CLI_SESSION_ID: args.nativeCliSessionId,
    MONAD_AGENT_TOKEN_FILE: tokenFile,
    MONAD_SERVER_URL: args.serverUrl,
    PATH: `${binDir}${args.baseEnvPath ? `:${args.baseEnvPath}` : ''}`
  };
  return {
    workspace,
    promptFile,
    tokenFile,
    tokenHash: hashManagedAgentToken(token),
    wrapperBin,
    mcpConfigArgs: managed?.mcpConfigArgs?.({ wrapperBin, env }) ?? [],
    prompt,
    env
  };
}
