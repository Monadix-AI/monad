import type { MonadPaths } from '@monad/environment';
import type { Logger } from '@monad/logger';
import type {
  EnvDepsStatusResponse,
  GetInitStatusResponse,
  InstallEnvDepsRequest,
  InstallEnvDepsResponse,
  OkResponse
} from '@monad/protocol';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeInitStatus, initMonadHome, loadAll, loadAuth, pathsForHome, setMonadRoot } from '@monad/environment';

import { HandlerError } from '#/handlers/handler-error.ts';
import { installEnvDeps } from '#/infra/env-deps.ts';

/** First-run setup: initialization status, home-directory relocation, and local runtime
 *  dependency (node/uv) install. Extracted from handlers.ts — self-contained aside from
 *  `paths`/`mockMode`/`log`, no other daemon dep. */
export function createInitHandlers(paths: MonadPaths, mockMode: boolean, log: Logger) {
  return {
    async status(): Promise<GetInitStatusResponse> {
      if (mockMode) return { initialized: true, missing: [], homePath: paths.home };
      const cfg = await loadAll(paths);
      const auth = cfg ? await loadAuth(paths.auth) : null;
      const status = cfg
        ? computeInitStatus(cfg, auth)
        : { initialized: false, missing: ['provider' as const, 'credential' as const, 'default' as const] };
      return { ...status, homePath: paths.home };
    },
    async setHome(newPath: string): Promise<OkResponse> {
      // Only allowed before initialization is complete.
      const cfg = await loadAll(paths);
      const auth = cfg ? await loadAuth(paths.auth) : null;
      const status = cfg ? computeInitStatus(cfg, auth) : { initialized: false, missing: [] };
      if (status.initialized) {
        throw new HandlerError('conflict', 'Already initialized — run monad reset to start over');
      }
      await setMonadRoot(newPath);
      await initMonadHome(pathsForHome(newPath));
      // Spawn detached so the child outlives this process.
      const proc = Bun.spawn(process.argv, { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
      proc.unref();
      setTimeout(() => process.exit(0), 100);
      return { ok: true };
    },
    async envDepsStatus(): Promise<EnvDepsStatusResponse> {
      const nodeState = existsSync(join(paths.bin, 'node'))
        ? ('installed' as const)
        : Bun.which('node') !== null
          ? ('found' as const)
          : ('missing' as const);
      const uvState = existsSync(join(paths.bin, 'uv'))
        ? ('installed' as const)
        : Bun.which('uv') !== null
          ? ('found' as const)
          : ('missing' as const);
      return { node: nodeState, uv: uvState };
    },
    async installEnvDepsHandler(req: InstallEnvDepsRequest): Promise<InstallEnvDepsResponse> {
      return installEnvDeps(paths.bin, req, log);
    }
  };
}
