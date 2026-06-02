import type { Session } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';

// Session origin records where a conversation began and how replies should be routed. It is not an
// authorization boundary: authenticated Web, TUI, and daemon control-plane clients may intentionally
// continue a session that originated in a channel or editor. Automation remains isolated because its
// lifecycle is owned by the scheduler rather than an interactive client.
export function assertSessionWriteAuthority(session: Session): void {
  if (session.origin?.surface === 'automation') {
    throw new HandlerError('forbidden', 'automation sessions cannot be written or branched by a transport');
  }
}
