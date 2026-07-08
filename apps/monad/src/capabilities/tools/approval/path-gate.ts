// Path-escalation helpers shared by file, shell, and process tools. When a sandbox path check
// fails, these re-route through the oversight gate so the user can approve expanding
// access to a directory outside the default sandbox roots.

import type { ToolContext } from '../types.ts';

import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, win32 } from 'node:path';

import { ToolSecurityError } from '../security.ts';
import { approvalDeniedMessage, requestPathAccess } from './resource-approval.ts';

export type PathAccessOperation = 'read' | 'write' | 'execute' | 'cwd';

interface GatePathAccessOptions {
  dir?: string;
  operation?: PathAccessOperation;
  pathKind?: 'file' | 'directory' | 'unknown';
  requestedByTool?: string;
}

/** Resolve the directory to gate on from a path that escaped the sandbox. */
function escapedDir(path: string, ctx: ToolContext): string {
  const base = ctx.sandboxRoots?.[0] ?? process.cwd();
  return dirname(isAbsolute(path) ? resolve(path) : resolve(base, path));
}

async function canonicalGateDir(dir: string): Promise<string> {
  try {
    return normalizePathApprovalKey(await realpath(dir));
  } catch {
    return normalizePathApprovalKey(resolve(dir));
  }
}

export function normalizePathApprovalKey(dir: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(dir) || /^\\\\[^\\]+\\[^\\]+/.test(dir)) {
    return win32.normalize(dir).toLowerCase();
  }
  return dir;
}

/**
 * When `err` is a path-escape ToolSecurityError and the tool context has a gate, ask the
 * gate for access to `dir` (defaults to the parent directory of `path`). Returns expanded
 * sandbox roots on allow; rethrows on deny, no gate, or any other error type.
 *
 * Uses tool name `path_access` and key = dir for read, or `<operation>:<dir>` for write/cwd/execute,
 * so remembered write/cwd grants do not imply read grants or each other.
 */
export async function gatePathAccess(
  path: string,
  ctx: ToolContext,
  err: unknown,
  options: string | GatePathAccessOptions = {}
): Promise<string[] | undefined> {
  if (!(err instanceof ToolSecurityError) || !err.message.startsWith('path escapes sandbox') || !ctx.gate) {
    throw err;
  }
  const opts = typeof options === 'string' ? { dir: options } : options;
  const requestedDir = resolve(opts.dir ?? escapedDir(path, ctx));
  const gateDir = await canonicalGateDir(requestedDir);
  const outcome = await requestPathAccess(ctx, {
    path,
    dir: gateDir,
    operation: opts.operation,
    pathKind: opts.pathKind ?? 'directory',
    requestedByTool: opts.requestedByTool,
    reason: err.message
  });
  if (!outcome.allow) throw new ToolSecurityError(approvalDeniedMessage('path', gateDir));
  return ctx.sandboxRoots ? [...new Set([...ctx.sandboxRoots, gateDir, requestedDir])] : undefined;
}
