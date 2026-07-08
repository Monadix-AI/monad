import type {
  ExternalAgentLaunchMode,
  NativeAgentMonadCliEntry,
  NativeAgentRuntimePromptInput,
  NativeAgentRuntimeSpec
} from '@monad/protocol';

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { getExternalAgentProviderAdapter } from '#/services/external-agent/index.ts';
import managedProjectRuntimeMcpPromptPath from './prompts/managed-project-runtime-mcp-prompt.md' with { type: 'file' };
import managedProjectRuntimePromptPath from './prompts/managed-project-runtime-prompt.md' with { type: 'file' };

const MANAGED_PROJECT_RUNTIME_PROMPT = (await Bun.file(managedProjectRuntimePromptPath).text()).trim();
const MANAGED_PROJECT_RUNTIME_MCP_PROMPT = (await Bun.file(managedProjectRuntimeMcpPromptPath).text()).trim();
const PROJECT_MEMORY_INDEX = [
  '# Project memory index',
  '',
  'Durable Workplace Project context shared across managed agents — decisions, conventions,',
  'status, and external references that a later agent cannot recover from `project read`',
  'or the code itself. Not a transcript: transient chatter and in-progress task state do not',
  'belong here.',
  '',
  '- Each line below points to one file under `memories/`: `- [title](memories/file.md) — one-line hook`.',
  '- A detail file starts with frontmatter (`name`, `description`, `metadata.type`); `type` is one of',
  '  `decision`, `convention`, `status`, `reference`.',
  '- Before writing, check whether an existing file already covers the topic and update it instead of',
  '  adding a duplicate.',
  '- Acquire `MEMORY.md.lock` before editing this file or any file under `memories/`; release it after',
  '  the write, even if the write fails.',
  ''
].join('\n');

type ManagedProjectPromptInput = NativeAgentRuntimePromptInput & { monadCliCommand: string };

function buildManagedProjectPrompt(args: ManagedProjectPromptInput): string {
  const runtimeMetadata = [
    `Agent name: ${args.agentName}`,
    ...(args.displayName ? [`Display name: ${args.displayName}`] : []),
    ...(args.displayName ? ['Display name is your project communication name.'] : []),
    'Agent name is an internal API/runtime id for Monad CLI calls only.',
    `Project id: ${args.projectId}`,
    `External agent session id: ${args.externalAgentSessionId}`,
    `Provider: ${args.provider}`,
    `Workspace: ${args.workspace}`,
    ...((args.modelId ?? args.modelName) ? [`Requested model: ${args.modelId ?? args.modelName}`] : []),
    ...(args.reasoningEffort ? [`Requested reasoning effort: ${args.reasoningEffort}`] : []),
    ...(args.speed ? [`Requested speed: ${args.speed}`] : [])
  ].join('\n');
  const customPromptBlock = args.customPrompt
    ? ['Project instance custom prompt:', args.customPrompt, ''].join('\n')
    : '';
  const usesMcpBridge = getExternalAgentProviderAdapter(args.provider).managedRuntime?.usesManagedMcpBridge ?? false;
  const template = usesMcpBridge ? MANAGED_PROJECT_RUNTIME_MCP_PROMPT : MANAGED_PROJECT_RUNTIME_PROMPT;
  return template
    .replace('{{runtimeMetadata}}', runtimeMetadata)
    .replace('{{customPromptBlock}}', customPromptBlock)
    .replaceAll('{{monadCliCommand}}', args.monadCliCommand);
}

function hashManagedAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function monadCliCommand(entry: NativeAgentMonadCliEntry): string {
  return [entry.command, ...entry.args].map(shellQuote).join(' ');
}

function managedProjectMonadCliEntry(): NativeAgentMonadCliEntry {
  const cliSourceEntry = join(import.meta.dir, '../../../../cli/src/main.ts');
  if (existsSync(cliSourceEntry)) return { command: 'bun', args: [cliSourceEntry] };
  return { command: process.execPath, args: [] };
}

function _managedProjectMonadCliCommand(): string {
  return monadCliCommand(managedProjectMonadCliEntry());
}

export function managedProjectLaunchMode(
  agent: Pick<NativeAgentRuntimePromptInput, 'provider'> & { defaultLaunchMode: ExternalAgentLaunchMode },
  requested?: ExternalAgentLaunchMode
): ExternalAgentLaunchMode {
  if (requested && requested !== 'pty') return requested;
  const managed = getExternalAgentProviderAdapter(agent.provider).managedRuntime;
  return managed?.launchMode?.(agent.defaultLaunchMode) ?? requested ?? agent.defaultLaunchMode;
}

export function cleanupManagedProjectRuntimeToken(workspace: string): void {
  try {
    unlinkSync(join(workspace, '.monad-agent-token'));
  } catch {
    /* token already absent */
  }
}

function cleanupManagedProjectRuntimeBin(workspace: string): void {
  rmSync(join(workspace, 'bin'), { recursive: true, force: true });
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
    throw new Error('managed external agent workspace must stay inside the project agent root');
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

function managedProjectRoot(args: { monadHome: string; projectId: string }): string {
  return resolve(args.monadHome, 'workplace-agents', args.projectId);
}

function prepareManagedProjectSharedMemory(root: string): void {
  mkdirSync(join(root, 'memories'), { recursive: true });
  const memoryFile = join(root, 'MEMORY.md');
  if (!existsSync(memoryFile)) writeFileSync(memoryFile, PROJECT_MEMORY_INDEX, { mode: 0o600 });
}

export function prepareManagedProjectRuntime(
  args: {
    monadHome: string;
    serverUrl: string;
    baseEnvPath?: string;
    platform?: NodeJS.Platform;
    /** The resolved autopilot outcome for this launch — threaded to `managedRuntime.env` so a provider
     *  whose autopilot toggle has no CLI-flag equivalent (OpenClaw) can write its own config instead.
     *  Defaults to false (don't silently disable a provider's own approval prompts) when omitted. */
    skipProviderApprovals?: boolean;
  } & Omit<NativeAgentRuntimePromptInput, 'workspace'>
): NativeAgentRuntimeSpec {
  const workspace = managedProjectRuntimeWorkspace(args);
  const projectRoot = managedProjectRoot(args);
  prepareManagedProjectSharedMemory(projectRoot);
  mkdirSync(workspace, { recursive: true });
  const monadCliEntry = managedProjectMonadCliEntry();
  const prompt = buildManagedProjectPrompt({
    agentName: args.agentName,
    ...(args.displayName ? { displayName: args.displayName } : {}),
    projectId: args.projectId,
    externalAgentSessionId: args.externalAgentSessionId,
    provider: args.provider,
    workspace,
    ...(args.modelName ? { modelName: args.modelName } : {}),
    ...(args.modelId ? { modelId: args.modelId } : {}),
    ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    ...(args.speed ? { speed: args.speed } : {}),
    ...(args.customPrompt ? { customPrompt: args.customPrompt } : {}),
    monadCliCommand: monadCliCommand(monadCliEntry)
  });
  const promptFile = join(workspace, 'managed-prompt.md');
  const tokenFile = join(workspace, '.monad-agent-token');
  const token = randomBytes(32).toString('hex');
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  cleanupManagedProjectRuntimeToken(workspace);
  cleanupManagedProjectRuntimeBin(workspace);
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const managed = getExternalAgentProviderAdapter(args.provider).managedRuntime;
  const env = {
    ...(managed?.env?.({ workspace, skipProviderApprovals: args.skipProviderApprovals ?? false }) ?? {}),
    MONAD_HOME: args.monadHome,
    MONAD_EXTERNAL_AGENT_SESSION_ID: args.externalAgentSessionId,
    MONAD_AGENT_TOKEN_FILE: tokenFile,
    MONAD_SERVER_URL: args.serverUrl,
    ...(args.baseEnvPath ? { PATH: args.baseEnvPath } : {})
  };
  return {
    workspace,
    promptFile,
    tokenFile,
    tokenHash: hashManagedAgentToken(token),
    monadCliEntry,
    mcpConfigArgs: managed?.mcpConfigArgs?.({ monadCliEntry, env }) ?? [],
    prompt,
    env
  };
}
