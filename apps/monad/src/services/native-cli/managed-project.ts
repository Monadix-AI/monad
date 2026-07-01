import type { ManagedProjectRuntimePromptInput, ManagedProjectRuntimeSpec } from '@monad/protocol';

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

function buildManagedProjectPrompt(args: ManagedProjectRuntimePromptInput): string {
  return [
    'You are a Monad-managed native CLI agent participating in a Workplace Project.',
    '',
    `Agent name: ${args.agentName}`,
    `Project session id: ${args.projectSessionId}`,
    `Native CLI session id: ${args.nativeCliSessionId}`,
    `Provider: ${args.provider}`,
    `Workspace: ${args.workspace}`,
    '',
    'Communication rules:',
    '- Public replies to project members must be sent with `monad project post <text>`.',
    '- To reply inside a project thread, use `monad project post --thread <messageId> <text>`.',
    '- Use `monad project read` to recover project or thread history.',
    '- Use `monad project inbox check` to read pending project messages when you are busy or resumed.',
    '- Use `monad agent send --to <agent|human> <text>` only for direct/private conversation.',
    '- Terminal stdout/stderr is diagnostic output only. It is not a Workplace Project message.',
    '- On startup, read MEMORY.md in the workspace before answering when it exists.',
    '- Provider-owned tool calls, approvals, login, and auth prompts remain inside your native CLI environment.'
  ].join('\n');
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

export function prepareManagedProjectRuntime(
  args: {
    monadHome: string;
    serverUrl: string;
    baseEnvPath?: string;
    platform?: NodeJS.Platform;
  } & Omit<ManagedProjectRuntimePromptInput, 'workspace'>
): ManagedProjectRuntimeSpec {
  const platform = args.platform ?? process.platform;
  const projectAgentRoot = resolve(args.monadHome, 'workplace-agents', args.projectSessionId);
  const workspace = resolve(projectAgentRoot, args.agentName);
  assertManagedWorkspaceContained(projectAgentRoot, workspace);
  const binDir = join(workspace, 'bin');
  mkdirSync(binDir, { recursive: true });
  const prompt = buildManagedProjectPrompt({
    agentName: args.agentName,
    projectSessionId: args.projectSessionId,
    nativeCliSessionId: args.nativeCliSessionId,
    provider: args.provider,
    workspace
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
  return {
    workspace,
    promptFile,
    tokenFile,
    tokenHash: hashManagedAgentToken(token),
    wrapperBin,
    prompt,
    env: {
      MONAD_NATIVE_CLI_SESSION_ID: args.nativeCliSessionId,
      MONAD_AGENT_TOKEN_FILE: tokenFile,
      MONAD_SERVER_URL: args.serverUrl,
      PATH: `${binDir}${args.baseEnvPath ? `:${args.baseEnvPath}` : ''}`
    }
  };
}
