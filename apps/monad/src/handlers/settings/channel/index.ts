import type { ChannelDeps } from '@/handlers/settings/channel/context.ts';

import { createChannelContext } from '@/handlers/settings/channel/context.ts';
import { createCredentialsHandlers } from '@/handlers/settings/channel/handlers/credentials.ts';
import { createInstancesHandlers } from '@/handlers/settings/channel/handlers/instances.ts';
import { createPairingHandlers } from '@/handlers/settings/channel/handlers/pairing.ts';
import { createStatusHandlers } from '@/handlers/settings/channel/handlers/status.ts';

export type { ChannelDeps } from '@/handlers/settings/channel/context.ts';

export function createChannelModule(deps: ChannelDeps) {
  const ctx = createChannelContext(deps);
  return Object.assign(
    createInstancesHandlers(ctx),
    createCredentialsHandlers(ctx),
    createPairingHandlers(ctx),
    createStatusHandlers(ctx)
  );
}
