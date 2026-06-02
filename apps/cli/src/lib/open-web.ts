import type { MonadClient } from '@monad/client';

import { openUrl } from '@monad/environment';

import { startDaemon } from './daemon.ts';
import { runBrowserInit } from './init-flow.ts';
import { cyan, out } from './output.ts';

/** Bare `monad` (and its `up` alias): start the daemon, then either run first-time browser setup or
 *  print and open the web UI. Extracted so the alias and the no-command path cannot drift. */
export async function startAndOpenWeb(client: MonadClient, baseUrl: string): Promise<void> {
  await startDaemon();
  const status = await client.treaty.v1.init.status.get();
  if (status.data && !status.data.initialized) {
    await runBrowserInit(client, parseInt(new URL(baseUrl).port || '47749', 10));
    return;
  }
  const url = `${baseUrl.replace(/\/$/, '')}/`;
  out(cyan(url));
  if (process.stdout.isTTY) openUrl(url);
}
