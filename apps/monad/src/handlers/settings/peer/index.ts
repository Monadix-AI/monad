import type { PeerDeps } from '#/handlers/settings/peer/context.ts';

import { createPeerContext } from '#/handlers/settings/peer/context.ts';
import { createPeerHandlers } from '#/handlers/settings/peer/handlers.ts';

export type { PeerDeps } from '#/handlers/settings/peer/context.ts';

export function createPeerModule(deps: PeerDeps) {
  return createPeerHandlers(createPeerContext(deps));
}
