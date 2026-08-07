import { openUrl, resolveClientConn } from '@monad/environment';

import { startDaemon } from './daemon.ts';
import { resolveUpWebUrl } from './web-url.ts';

interface UpDeps {
  openUrl(url: string): boolean;
  resolveClientConn(): Promise<{ baseUrl: string }>;
  startDaemon(): Promise<unknown>;
  write(message: string): void;
}

const defaultDeps: UpDeps = {
  openUrl,
  resolveClientConn,
  startDaemon,
  write: (message) => process.stdout.write(message)
};

export async function runUp(
  options: { noOpen: boolean; nodeEnv?: string; webPort?: string },
  deps: UpDeps = defaultDeps
): Promise<string> {
  await deps.startDaemon();
  const { baseUrl } = await deps.resolveClientConn();
  const webUrl = resolveUpWebUrl({ daemonUrl: baseUrl, nodeEnv: options.nodeEnv, webPort: options.webPort });
  deps.write(`Monad — ${webUrl}\n`);
  if (!options.noOpen) deps.openUrl(webUrl);
  return webUrl;
}
