import type { MonadAuth, MonadConfig } from '@monad/environment';
import type { Logger } from '@monad/logger';

import { computeInitStatus } from '@monad/environment';

export function warnIfNotInitialized(deps: {
  cfg: MonadConfig;
  auth: MonadAuth | undefined;
  host: string;
  port: number;
  logger: Logger;
}): void {
  const { cfg, auth, host, port, logger } = deps;
  const initStatus = computeInitStatus(cfg, auth ?? null);
  if (initStatus.initialized) return;
  const missing = initStatus.missing.length ? `missing ${initStatus.missing.join(', ')}` : 'missing setup';
  const providerCredentials = initStatus.missingProviderCredentials
    ?.map((item) => `${item.providerLabel ?? item.providerId} (${item.providerId})`)
    .join(', ');
  const providerCredentialHint = providerCredentials ? `; provider credentials: ${providerCredentials}` : '';
  logger.warn(
    `monad is not initialized — ${missing}${providerCredentialHint} — run \`monad init\` or open http://${host}:${port}/`
  );
}
