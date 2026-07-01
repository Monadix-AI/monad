import { defaultTransport, loadAll } from './config.ts';
import { getPaths } from './paths.ts';

// `unixSocket` is returned only when transport="uds" — local REST/SSE routes over it.
// `baseUrl` is always returned because the WebSocket push channel can only run over TCP.
export async function resolveClientConn(): Promise<{
  baseUrl: string;
  token: string | null;
  unixSocket?: string;
}> {
  const paths = getPaths();
  const cfg = await loadAll(paths.config, paths.profile);
  // MONAD_PORT (dev: per-worktree daemon port) must override config so clients dial the same
  // port the daemon bound; see apps/monad/src/main.ts. Unset in production → use config.json.
  const port = Number(Bun.env.MONAD_PORT) || cfg?.network.port || 52749;
  const token = cfg?.network.remoteAccess.token ?? null;
  // Bun has no Unix-socket support on Windows (named pipes unimplemented — oven-sh/bun#13042), and the
  // daemon never binds the socket there (serveDaemon skips it). Force TCP regardless of a stale/manual
  // `uds` config, so the client never dials a socket that cannot exist and pay a failed-connect +
  // TCP-fallback on the first request of every client instance.
  const transport = process.platform === 'win32' ? 'tcp' : (cfg?.network.transport ?? defaultTransport());
  const unixSocket = transport === 'uds' ? paths.sock : undefined;
  // When remote access is enabled the daemon serves HTTPS. On platforms that use UDS
  // (macOS / Linux) the CLI tunnels through the socket and TLS never comes up — but on
  // Windows (TCP only) we must dial https:// or the TLS handshake fails.
  const useTls = (cfg?.network.remoteAccess.enabled ?? false) && !unixSocket;
  const scheme = useTls ? 'https' : 'http';
  return { baseUrl: `${scheme}://127.0.0.1:${port}`, token, unixSocket };
}
