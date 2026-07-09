// Per-session ephemeral sandbox roots: the disposable working area a confined child writes to.
// One dir per session under <baseDir>, created on first use and removed when the session ends, so
// code/downloads/installed deps live across that session's tool calls but never pollute the host.
// A boot-time sweep reclaims roots left behind by a crash (mirrors the orphan-stream cleanup).
//
// The session id reaches us from agent-controllable context, so it is sanitized to a single safe
// path segment — a sandbox root must never escape baseDir via "../" or an absolute path.

import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Collapse a session id to one filesystem-safe segment (defeats path traversal). */
export function sandboxDirName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  // Never let an empty / dot-only id resolve to baseDir itself or its parent.
  return safe === '' || safe === '.' || safe === '..' ? `_${Buffer.from(sessionId).toString('hex')}` : safe;
}

export function sessionSandboxPath(baseDir: string, sessionId: string): string {
  return join(baseDir, sandboxDirName(sessionId));
}

/** Create (idempotently) the session's ephemeral root and return its path. */
export async function createSessionSandbox(baseDir: string, sessionId: string): Promise<string> {
  const dir = sessionSandboxPath(baseDir, sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Remove the session's root and everything under it. Safe to call when it never existed. */
export async function disposeSessionSandbox(baseDir: string, sessionId: string): Promise<void> {
  await rm(sessionSandboxPath(baseDir, sessionId), { recursive: true, force: true });
}

/**
 * Delete every sandbox root under baseDir whose session is not in `keep` — reclaims dirs orphaned
 * by a crash/restart. Returns the number removed. Missing baseDir → no-op.
 */
export async function sweepOrphanSandboxes(baseDir: string, keep: Iterable<string>): Promise<number> {
  const keepNames = new Set([...keep].map(sandboxDirName));
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return 0; // baseDir not created yet
  }
  let removed = 0;
  for (const name of entries) {
    if (keepNames.has(name)) continue;
    await rm(join(baseDir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}
