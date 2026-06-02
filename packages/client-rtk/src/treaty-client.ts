import type { MonadClientOptions } from '@monad/client';

import { MonadClient } from '@monad/client';

export function createMonadTreatyClient(opts: MonadClientOptions): MonadClient {
  return new MonadClient(opts);
}
