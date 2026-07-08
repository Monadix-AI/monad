// shell_exec — high-risk when it escapes containment. With an active OS sandbox and sandbox roots,
// commands inside the roots run without a primary prompt. Otherwise the primary gate is
// tool-dimensional: key = leading command token (e.g. "git"), so "always allow git" works without
// blanket-approving every command. When the requested cwd escapes the sandbox, the shared path gate
// uses key = /abs/dir so remembered approvals cover file, shell, and process access consistently.
// Execution itself lives in the terminal backend (backends.ts): the sandbox backend spawns on
// the daemon host; an ACP session's backend runs it in the editor's integrated terminal.

import type { Tool, ToolContext } from '../types.ts';

import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

import { gatePathAccess } from '../approval/path-gate.ts';
import { createSandboxBackends } from '../backends.ts';
import { canSkipHighRiskApprovalInLocalSandbox } from '../sandbox/active-local.ts';
import { assertPathWithinRoots } from '../security.ts';
import { toolResult } from '../types.ts';

const MAX_TIMEOUT_MS = 600_000;

// Shell resolution lives in backends.ts (single source of truth). Re-exported so process.ts,
// the package index, and apps/cli keep importing them from here unchanged.
export { shellArgv } from '../backends.ts';

const shellExecInput = z.object({
  command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional()
});

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function terminalBackend(ctx: ToolContext) {
  return (
    ctx.backends?.terminal ??
    createSandboxBackends(ctx.sandboxRoots, { defaultCwd: ctx.defaultCwd, sessionId: ctx.sessionId }).terminal
  );
}

/** Leading token of the command string (basename only, no path separators). */
function commandName(command: string | string[]): string | undefined {
  const first = Array.isArray(command) ? command[0] : command;
  const token = first?.trim().split(/\s+/, 1)[0];
  return token ? token.split(/[/\\]/).pop() : undefined;
}

export const shellExecTool: Tool<z.infer<typeof shellExecInput>, ShellResult> = {
  name: 'shell_exec',
  description:
    'Run a non-interactive shell command and capture stdout, stderr, and exit code. For commands that may require runtime input or terminal interaction, use process_start, process_logs, and process_write. Runs without primary approval inside an active OS sandbox; host-wide or out-of-sandbox execution is approval-gated.',
  scopes: [{ resource: 'shell:exec' }],
  highRisk: true,
  needsApproval: (_input, ctx) => !canSkipHighRiskApprovalInLocalSandbox(ctx),
  // Narrow remembered approvals to the command family (leading token of the first word) so a user
  // can "always allow git" without blanket-approving every shell command. Array form keys off its
  // first element. Undefined → whole-tool rule.
  gateKey: ({ command }) => commandName(command),
  inputSchema: shellExecInput,
  run: async ({ command, cwd, timeoutMs }, ctx) => {
    const exec = (term: ReturnType<typeof terminalBackend>) =>
      term.exec({ command, cwd, timeoutMs, signal: ctx.signal, onChunk: ctx.reportProgress });

    // When cwd escapes the sandbox, use the shared path gate before attempting execution.
    // A remembered path_access:/abs/dir approval covers file, shell, and process tools.
    const roots = ctx.sandboxRoots;
    if (cwd && roots?.length) {
      try {
        assertPathWithinRoots(cwd, roots);
      } catch (err) {
        const dir = isAbsolute(cwd) ? resolve(cwd) : resolve(roots[0] ?? process.cwd(), cwd);
        const expanded = await gatePathAccess(cwd, ctx, err, {
          dir,
          operation: 'cwd',
          pathKind: 'directory',
          requestedByTool: 'shell_exec'
        });
        return toolResult(
          await exec(createSandboxBackends(expanded, { defaultCwd: ctx.defaultCwd, sessionId: ctx.sessionId }).terminal)
        );
      }
    }

    return toolResult(await exec(terminalBackend(ctx)));
  }
};

const shellTools: Tool[] = [shellExecTool as Tool];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => shellTools;
