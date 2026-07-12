import type { MonadConfig } from '@monad/home';

export function buildExternalAgentServerUrl(args: { port: number; https: MonadConfig['network']['https'] }): string {
  const scheme = args.https.enabled ? 'https' : 'http';
  return `${scheme}://127.0.0.1:${args.port}`;
}
