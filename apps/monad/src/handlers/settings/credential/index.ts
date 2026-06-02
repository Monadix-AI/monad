import type { ConfigAccess } from '#/config/manager.ts';

import { createCredentialContext } from './context.ts';
import { createCredentialHandlers } from './handlers.ts';

export function createCredentialModule(config: ConfigAccess) {
  return createCredentialHandlers(createCredentialContext(config));
}
