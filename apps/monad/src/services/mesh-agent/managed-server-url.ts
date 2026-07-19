import { resolveDaemonUrl } from '@monad/environment';

export function resolveMeshAgentManagedServerUrl(opts: {
  serverUrl?: string;
  networkHttps?: { enabled: boolean };
  port?: number | string;
}): string {
  return resolveDaemonUrl({
    network: {
      https: opts.networkHttps,
      ...(opts.port ? { port: Number(opts.port) } : {})
    },
    env: {
      ...Bun.env,
      ...(opts.port === undefined ? {} : { MONAD_PORT: String(opts.port) }),
      ...(opts.serverUrl ? { MONAD_URL: opts.serverUrl } : {})
    }
  });
}
