// Per-session ephemeral sandbox roots (sandbox mode 'ephemeral'). Each session runs against a
// fresh disposable dir under cache/sandboxes/<id>, created on demand and removed when the session
// ends; a boot sweep reclaims roots left by a crash. Disabled in every other mode → a no-op that
// returns undefined, so the agent keeps using the global sandbox roots.

import { cp } from 'node:fs/promises';

import {
  buildSandboxPolicy,
  createSessionSandbox,
  disposeSessionSandbox,
  sandboxedSpawn,
  shellArgv,
  sweepOrphanSandboxes
} from '#/capabilities/tools';

export interface SessionSandboxService {
  readonly enabled: boolean;
  /** Create (idempotently) the session's root and return it as sandbox roots, or undefined when disabled. */
  ensure(sessionId: string): Promise<string[] | undefined>;
  /** Remove the session's root. No-op when disabled or never created. */
  dispose(sessionId: string): Promise<void>;
  /** Reclaim roots not belonging to a live session. Returns the count removed. */
  sweep(activeSessionIds: Iterable<string>): Promise<number>;
}

export function createSessionSandboxService(opts: {
  enabled: boolean;
  baseDir: string;
  seedTemplate?: string;
  initScript?: string;
  log?: (message: string) => void;
}): SessionSandboxService {
  const { enabled, baseDir } = opts;
  return {
    enabled,
    async ensure(sessionId) {
      if (!enabled) return undefined;
      const root = await createSessionSandbox(baseDir, sessionId);

      if (opts.seedTemplate) {
        try {
          await cp(opts.seedTemplate, root, { recursive: true });
        } catch (err) {
          opts.log?.(
            `session ${sessionId}: seedTemplate copy failed — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (opts.initScript) {
        const argv = shellArgv(opts.initScript);
        const proc = sandboxedSpawn(argv, { cwd: root, stdout: 'pipe', stderr: 'pipe' }, buildSandboxPolicy([root]));
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const code = await proc.exited;
        if (code !== 0) {
          opts.log?.(`session ${sessionId}: initScript exited ${code} — ${(err || out).slice(0, 300)}`);
        } else {
          opts.log?.(`session ${sessionId}: initScript done`);
        }
      }

      return [root];
    },
    async dispose(sessionId) {
      if (!enabled) return;
      await disposeSessionSandbox(baseDir, sessionId);
    },
    async sweep(activeSessionIds) {
      if (!enabled) return 0;
      const removed = await sweepOrphanSandboxes(baseDir, activeSessionIds);
      if (removed > 0) opts.log?.(`reclaimed ${removed} orphan session sandbox root(s)`);
      return removed;
    }
  };
}
