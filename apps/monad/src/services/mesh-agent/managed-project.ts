import type {
  NativeAgentRuntimePromptInput,
  NativeAgentRuntimeSpec,
  NativeAgentWorkspaceScopes
} from '@monad/protocol';

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { definePrompt } from '#/agent/prompt-template.ts';
import { getMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';
import { resolveDaemonMonadCliEntry } from '#/services/mesh-agent/invitable-agents.ts';
import managedProjectRuntimeMcpPromptPath from './prompts/managed-project-runtime-mcp.prompt.md' with { type: 'file' };
import projectMemoryIndexPath from './prompts/project-memory-index.prompt.md' with { type: 'file' };

const MANAGED_PROJECT_RUNTIME_PROMPT = await definePrompt<NativeAgentRuntimePromptInput>({
  id: 'managed-project.runtime-mcp',
  sourcePath: managedProjectRuntimeMcpPromptPath
});
const PROJECT_MEMORY_INDEX_PROMPT = await definePrompt({
  id: 'managed-project.memory-index',
  sourcePath: projectMemoryIndexPath
});

function buildManagedProjectPrompt(args: NativeAgentRuntimePromptInput): string {
  if (getMeshAgentProviderAdapter(args.provider).managedRuntime?.usesManagedMcpBridge !== true) {
    throw new Error(`${args.provider} managed runtime does not provide the required Monad MCP bridge`);
  }
  return MANAGED_PROJECT_RUNTIME_PROMPT.render(args);
}

function hashManagedAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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
  const root = join(monadHome, 'workplace');
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
    throw new Error('managed MeshAgent workspace must stay inside the project root');
  }
}

export function managedProjectRuntimeWorkspace(args: {
  monadHome: string;
  projectId: string;
  sessionId: string;
  agentId: string;
}): string {
  return managedProjectRuntimeWorkspaces(args).runtime;
}

export function managedProjectSharedWorkspace(args: { monadHome: string; projectId: string }): string {
  const project = resolve(args.monadHome, 'workplace', args.projectId);
  const shared = resolve(project, 'shared');
  assertManagedWorkspaceContained(project, shared);
  return shared;
}

export function managedProjectRuntimeWorkspaces(args: {
  monadHome: string;
  projectId: string;
  sessionId: string;
  agentId: string;
}): NativeAgentWorkspaceScopes {
  const project = resolve(args.monadHome, 'workplace', args.projectId);
  const workspaces = {
    project,
    shared: resolve(project, 'shared'),
    agent: resolve(project, 'agents', args.agentId),
    session: resolve(project, 'sessions', args.sessionId),
    runtime: resolve(project, 'runtime', args.sessionId, args.agentId)
  };
  for (const workspace of Object.values(workspaces).slice(1)) assertManagedWorkspaceContained(project, workspace);
  return workspaces;
}

function prepareManagedProjectSharedMemory(sharedWorkspace: string): void {
  mkdirSync(join(sharedWorkspace, 'memories'), { recursive: true });
  const memoryFile = join(sharedWorkspace, 'MEMORY.md');
  try {
    writeFileSync(memoryFile, PROJECT_MEMORY_INDEX_PROMPT.render({}), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export function prepareManagedProjectRuntime(
  args: {
    monadHome: string;
    serverUrl: string;
    meshSessionId: string;
    workingPath?: string;
    baseEnvPath?: string;
    agentCommand?: string;
    agentEnv?: Readonly<Record<string, string>>;
    platform?: NodeJS.Platform;
    /** The resolved autopilot outcome for this launch — threaded to `managedRuntime.env` so a provider
     *  whose autopilot toggle has no CLI-flag equivalent can write its own config instead.
     *  Defaults to false (don't silently disable a provider's own approval prompts) when omitted. */
    skipProviderApprovals?: boolean;
    agentId?: NativeAgentRuntimePromptInput['agentId'];
    sessionId?: NativeAgentRuntimePromptInput['sessionId'];
  } & Omit<NativeAgentRuntimePromptInput, 'agentId' | 'sessionId' | 'workspace' | 'workspaces'>
): NativeAgentRuntimeSpec {
  const agentId = args.agentId ?? args.agentName;
  const sessionId = args.sessionId ?? (args.projectId as NativeAgentRuntimePromptInput['sessionId']);
  const workspaces = managedProjectRuntimeWorkspaces({ ...args, agentId, sessionId });
  const workspace = workspaces.runtime;
  prepareManagedProjectSharedMemory(workspaces.shared);
  for (const path of [workspaces.agent, workspaces.session, workspaces.runtime]) mkdirSync(path, { recursive: true });
  const monadCliEntry = resolveDaemonMonadCliEntry();
  const prompt = buildManagedProjectPrompt({
    agentName: args.agentName,
    agentId,
    ...(args.displayName ? { displayName: args.displayName } : {}),
    projectId: args.projectId,
    sessionId,
    provider: args.provider,
    workspace,
    workspaces,
    ...(args.modelName ? { modelName: args.modelName } : {}),
    ...(args.modelId ? { modelId: args.modelId } : {}),
    ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    ...(args.speed ? { speed: args.speed } : {}),
    ...(args.customPrompt ? { customPrompt: args.customPrompt } : {})
  });
  const promptFile = join(workspace, 'GEMINI.md');
  const tokenFile = join(workspace, '.monad-agent-token');
  const token = randomBytes(32).toString('hex');
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  cleanupManagedProjectRuntimeToken(workspace);
  cleanupManagedProjectRuntimeBin(workspace);
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const managed = getMeshAgentProviderAdapter(args.provider).managedRuntime;
  const bridgeEnv = {
    MONAD_HOME: args.monadHome,
    MONAD_PROJECT_WORKSPACE: workspaces.project,
    MONAD_SHARED_WORKSPACE: workspaces.shared,
    MONAD_AGENT_WORKSPACE: workspaces.agent,
    MONAD_SESSION_WORKSPACE: workspaces.session,
    MONAD_RUNTIME_WORKSPACE: workspaces.runtime,
    MONAD_MESH_SESSION_ID: args.meshSessionId,
    MONAD_AGENT_TOKEN_FILE: tokenFile,
    MONAD_SERVER_URL: args.serverUrl,
    ...(args.baseEnvPath ? { PATH: args.baseEnvPath } : {})
  };
  const mcpServer = {
    name: 'monad',
    command: monadCliEntry.command,
    args: [...monadCliEntry.args, 'native-agent', 'mcp-server'],
    env: bridgeEnv
  };
  const env = {
    ...(managed?.env?.({
      workspace,
      workingPath: args.workingPath ?? workspace,
      immutableInstructions: { text: prompt, file: promptFile },
      skipProviderApprovals: args.skipProviderApprovals ?? false,
      agentCommand: args.agentCommand ?? args.provider,
      agentEnv: args.agentEnv,
      mcpServer
    }) ?? {}),
    ...bridgeEnv
  };
  return {
    workspace,
    workspaces,
    promptFile,
    tokenFile,
    tokenHash: hashManagedAgentToken(token),
    monadCliEntry,
    mcpServer,
    mcpConfigArgs: managed?.mcpConfigArgs?.({ monadCliEntry, env }) ?? [],
    prompt,
    env
  };
}
