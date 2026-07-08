import type { MonadPaths } from '@monad/home';
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
import { computeInitStatus, initMonadHome, loadAll, loadAuth, setMonadRoot } from '@monad/home';

import { installEnvDeps } from '#/bootstrap/env-deps.ts';
import { HandlerError } from '#/handlers/handler-error.ts';

/** First-run setup: initialization status, home-directory relocation, and local runtime
 *  dependency (node/uv) install. Extracted from handlers.ts — self-contained aside from
 *  `paths`/`mockMode`/`log`, no other daemon dep. */
export function createInitHandlers(paths: MonadPaths, mockMode: boolean, log: Logger) {
  return {
    async status(): Promise<GetInitStatusResponse> {
      if (mockMode) return { initialized: true, missing: [], homePath: paths.home };
      const cfg = await loadAll(paths.config, paths.profile);
      const auth = cfg ? await loadAuth(paths.auth) : null;
      const status = cfg
        ? computeInitStatus(cfg, auth)
        : { initialized: false, missing: ['provider' as const, 'credential' as const, 'default' as const] };
      return { ...status, homePath: paths.home };
    },
    async setHome(newPath: string): Promise<OkResponse> {
      // Only allowed before initialization is complete.
      const cfg = await loadAll(paths.config, paths.profile);
      const auth = cfg ? await loadAuth(paths.auth) : null;
      const status = cfg ? computeInitStatus(cfg, auth) : { initialized: false, missing: [] };
      if (status.initialized) {
        throw new HandlerError('conflict', 'Already initialized — run monad reset to start over');
      }
      await setMonadRoot(newPath);
      await initMonadHome({
        ...paths,
        home: newPath,
        configs: `${newPath}/configs`,
        config: `${newPath}/configs/config.json`,
        profile: `${newPath}/configs/profile.json`,
        credentials: `${newPath}/credentials`,
        auth: `${newPath}/credentials/auth.json`,
        tls: `${newPath}/credentials/tls`,
        workspace: `${newPath}/agents/default`,
        providers: `${newPath}/atoms/providers`,
        skills: `${newPath}/atoms/skills`,
        atoms: `${newPath}/atoms`,
        agents: `${newPath}/agents`,
        cache: `${newPath}/cache`,
        runtime: `${newPath}/runtime`,
        db: `${newPath}/runtime/monad.sqlite`,
        sock: `${newPath}/runtime/monad.sock`,
        kvSock: `${newPath}/runtime/kv.sock`,
        pid: `${newPath}/runtime/monad.pid`
      });
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
