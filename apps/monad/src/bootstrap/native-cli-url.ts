import type { MonadConfig } from '@monad/home';

export function buildNativeCliServerUrl(args: {
  port: number;
  remoteAccess: MonadConfig['network']['remoteAccess'];
}): string {
  const scheme = args.remoteAccess.enabled && !args.remoteAccess.allowInsecureHttp ? 'https' : 'http';
  return `${scheme}://127.0.0.1:${args.port}`;
}
