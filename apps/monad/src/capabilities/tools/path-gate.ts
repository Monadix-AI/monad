// Path-escalation helpers shared by fs and shell tools. When a sandbox path check
// fails, these re-route through the oversight gate so the user can approve expanding
// access to a directory outside the default sandbox roots.

import type { ToolContext } from './types.ts';

import { dirname, isAbsolute, resolve } from 'node:path';

import { ToolSecurityError } from './security.ts';

/** Resolve the directory to gate on from a path that escaped the sandbox. */
function escapedDir(path: string, ctx: ToolContext): string {
  const base = ctx.sandboxRoots?.[0] ?? process.cwd();
  return dirname(isAbsolute(path) ? resolve(path) : resolve(base, path));
}

/**
 * When `err` is a path-escape ToolSecurityError and the tool context has a gate, ask the
 * gate for access to `dir` (defaults to the parent directory of `path`). Returns expanded
 * sandbox roots on allow; rethrows on deny, no gate, or any other error type.
 *
 * Uses tool name `fs_path_access` and key = the directory so the approval policy engine
 * can remember the decision and auto-allow on subsequent calls to the same directory —
 * shared between fs and shell tools so approving a directory once covers both.
 */
export async function gatePathAccess(
  path: string,
  ctx: ToolContext,
  err: unknown,
  dir?: string
): Promise<string[] | undefined> {
  if (!(err instanceof ToolSecurityError) || !err.message.startsWith('path escapes sandbox') || !ctx.gate) {
    throw err;
  }
  const gateDir = dir ?? escapedDir(path, ctx);
  const outcome = await ctx.gate({
    tool: 'fs_path_access',
    key: gateDir,
    sessionId: ctx.sessionId,
    highRisk: false,
    input: { path }
  });
  if (!outcome.allow) throw err;
  return ctx.sandboxRoots ? [...ctx.sandboxRoots, gateDir] : undefined;
}
