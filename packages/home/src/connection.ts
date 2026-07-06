import { DEFAULT_TRANSPORT, loadAll } from './config/index.ts';
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
  const transport = cfg?.network.transport ?? DEFAULT_TRANSPORT;
  // The daemon serves the socket on every platform (Bun supports AF_UNIX on Windows too). If it ever
  // isn't reachable — an older daemon, a bind that failed — the client's Unix fetcher falls back to
  // TCP at connect time (see makeUnixFetcher), so `uds` is always safe to request.
  const unixSocket = transport === 'uds' ? paths.sock : undefined;
  // When remote access is enabled the daemon serves HTTPS. On platforms that use UDS
  // (macOS / Linux) the CLI tunnels through the socket and TLS never comes up — but on
  // Windows (TCP only) we must dial https:// or the TLS handshake fails.
  const useTls = (cfg?.network.remoteAccess.enabled ?? false) && !unixSocket;
  const scheme = useTls ? 'https' : 'http';
  return { baseUrl: `${scheme}://127.0.0.1:${port}`, token, unixSocket };
}
