// ACP bridge launch: instead of building a full daemon in-process, `monad --acp` discovers a running
// daemon over the local Unix socket (auto-spawning one if absent) and bridges the editor's ACP
// connection to it. The agent loop then runs in that shared daemon, so editor sessions show up in the
// Web UI/CLI and reuse one store/model config. See bridge.ts for the proxy handlers.

import type { MonadConfig, MonadPaths } from '@monad/home';

import { loadConfig, resolveDaemonNetwork } from '@monad/home';
import { createLogger } from '@monad/logger';

import { createBridgeHandlers } from '@/transports/acp/bridge.ts';
import { startAcpTransport } from '@/transports/acp/connection.ts';

const log = createLogger('transport:acp:launch');

// Cosmetic only when dialing the Unix socket (used for the URL + Host header). Matches the daemon's
// configured default; overridden by cfg.network.port / MONAD_PORT when available.
const DEFAULT_PORT = 52749;
const SPAWN_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 200;

type UnixFetchInit = RequestInit & { unix?: string };

export function computeAcpBridgeUrls(opts: { https: MonadConfig['network']['https']; port: number }): {
  tcpBaseUrl: string;
  unixBaseUrl: string;
} {
  const endpoint = resolveDaemonNetwork({ network: { https: opts.https, port: opts.port } });
  return {
    tcpBaseUrl: endpoint.localUrl,
    unixBaseUrl: endpoint.unixUrl
  };
}

/** Compute the argv/env for the daemon we auto-spawn from bridge mode. CRITICAL: it must NOT inherit
 * the ACP/stdio flag OR env, or the child re-enters bridge mode and spawns again — an infinite loop.
 * The CLI (`monad acp`) launches us with BOTH the `--acp` flag and `MONAD_ACP=true`, so strip both. */
export function computeDaemonSpawn(
  argv: readonly string[],
  env: Record<string, string | undefined>
): { argv: string[]; env: Record<string, string | undefined> } {
  const spawnArgv = argv.filter((a) => a !== '--acp' && a !== '--stdio');
  const spawnEnv = { ...env };
  delete spawnEnv.MONAD_ACP;
  delete spawnEnv.MONAD_STDIO;
  return { argv: spawnArgv, env: spawnEnv };
}

async function probeDaemon(baseUrl: string, unixSocket: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { unix: unixSocket } as UnixFetchInit);
    return res.ok;
  } catch {
    return false; // socket missing / daemon not listening yet
  }
}

/** Ensure a daemon is reachable on `unixSocket`; spawn a detached one and wait for health if not.
 * The spawned daemon must NOT inherit the ACP flag/env, or it would re-enter bridge mode and loop. */
async function ensureDaemon(baseUrl: string, unixSocket: string): Promise<void> {
  if (await probeDaemon(baseUrl, unixSocket)) return;

  log.info('no running daemon found — spawning one for the acp bridge');
  const { argv, env } = computeDaemonSpawn(process.argv, Bun.env);
  const proc = Bun.spawn(argv, { detached: true, stdio: ['ignore', 'ignore', 'ignore'], env });
  proc.unref();

  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    if (await probeDaemon(baseUrl, unixSocket)) {
      log.info('daemon is up — bridging');
      return;
    }
  }
  throw new Error('monad: timed out waiting for the daemon to start for the acp bridge');
}

/** Run the ACP transport as a thin bridge to a (possibly auto-spawned) local daemon. */
export async function runAcpBridge(paths: MonadPaths): Promise<void> {
  const cfg = await loadConfig(paths.config);
  const port = Number(Bun.env.MONAD_PORT) || cfg?.network.port || DEFAULT_PORT;
  const { tcpBaseUrl, unixBaseUrl } = computeAcpBridgeUrls({ https: cfg?.network.https ?? { enabled: true }, port });
  // The bridge always dials the LOCAL Unix socket, so delegation/session-scoped MCP (later phases)
  // can keep the "local editor = trust boundary" assumption — a remote daemon is never targeted.
  await ensureDaemon(unixBaseUrl, paths.sock);
  const { handlers } = createBridgeHandlers({ baseUrl: unixBaseUrl, tcpBaseUrl, unixSocket: paths.sock });
  process.stderr.write('monad: acp bridge → shared daemon\n');
  await startAcpTransport(handlers);
}
