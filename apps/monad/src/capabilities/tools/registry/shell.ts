// shell_exec — HIGH-RISK: a command can do anything regardless of cwd, so the filesystem
// sandbox cannot contain it. The primary gate (human-approved every call) is tool-dimensional:
// key = leading command token (e.g. "git"), so "always allow git" works without blanket-approving
// every command. When the requested cwd escapes the sandbox a secondary gate fires with a
// narrower key of the form "git@/abs/dir", keeping the two approval dimensions separate:
// what command runs vs. where it runs.
// Execution itself lives in the terminal backend (backends.ts): the sandbox backend spawns on
// the daemon host; an ACP session's backend runs it in the editor's integrated terminal.

import type { Tool, ToolContext } from '../types.ts';

import { isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';

import { createSandboxBackends } from '../backends.ts';
import { ToolSecurityError } from '../security.ts';
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

function withinRoots(dir: string, roots: string[]): boolean {
  return roots.some((r) => dir === r || dir.startsWith(r + sep) || dir.startsWith(`${r}/`));
}

export const shellExecTool: Tool<z.infer<typeof shellExecInput>, ShellResult> = {
  name: 'shell_exec',
  description:
    'Run a non-interactive shell command and capture stdout, stderr, and exit code. For commands that may require runtime input or terminal interaction, use process_start, process_logs, and process_write. High-risk: routed through human approval.',
  scopes: [{ resource: 'shell:exec' }],
  highRisk: true,
  // Narrow remembered approvals to the command family (leading token of the first word) so a user
  // can "always allow git" without blanket-approving every shell command. Array form keys off its
  // first element. Undefined → whole-tool rule.
  gateKey: ({ command }) => commandName(command),
  inputSchema: shellExecInput,
  run: async ({ command, cwd, timeoutMs }, ctx) => {
    const exec = (term: ReturnType<typeof terminalBackend>) =>
      term.exec({ command, cwd, timeoutMs, signal: ctx.signal, onChunk: ctx.reportProgress });

    // When cwd escapes the sandbox, fire a secondary gate keyed on "cmd@/abs/dir" before
    // attempting execution. This keeps the approval dimensions orthogonal: the primary gate
    // (above) approved the command type; this gate approves the specific out-of-sandbox
    // destination. A remembered "git@/path" rule auto-allows without re-prompting.
    const roots = ctx.sandboxRoots;
    const [firstRoot] = roots ?? [];
    if (cwd && roots?.length && ctx.gate) {
      const dir = isAbsolute(cwd) ? cwd : resolve(firstRoot ?? process.cwd(), cwd);
      if (!withinRoots(dir, roots)) {
        const cmd = commandName(command);
        const outcome = await ctx.gate({
          tool: 'shell_exec',
          key: cmd ? `${cmd}@${dir}` : dir,
          sessionId: ctx.sessionId,
          highRisk: true,
          input: { command, cwd: dir }
        });
        if (!outcome.allow) throw new ToolSecurityError(`path escapes sandbox: ${cwd}`);
        const expanded = [...roots, dir];
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
