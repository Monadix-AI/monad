import { DEFAULT_TRANSPORT, loadAll } from './config/index.ts';
import { resolveDaemonNetwork } from './network-endpoints.ts';
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
  const endpoint = resolveDaemonNetwork({ network: cfg?.network, env: Bun.env });
  const token = cfg?.network.remoteAccess.token ?? null;
  const transport = cfg?.network.transport ?? DEFAULT_TRANSPORT;
  // The daemon serves the socket on every platform (Bun supports AF_UNIX on Windows too). If it ever
  // isn't reachable — an older daemon, a bind that failed — the client's Unix fetcher falls back to
  // TCP at connect time (see makeUnixFetcher), so `uds` is always safe to request.
  const unixSocket = transport === 'uds' ? paths.sock : undefined;
  return { baseUrl: endpoint.localUrl, token, unixSocket };
}
