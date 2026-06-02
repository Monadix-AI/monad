import type { OperationSource, Session } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { HandlerError } from '#/handlers/handler-error.ts';
import { assertSessionWriteAuthority } from '#/handlers/session/transport-authority.ts';

// The helper only reads `session.origin`; a minimal structural stand-in exercises the containment rules.
const sessionWith = (origin?: Partial<OperationSource>): Session =>
  ({
    origin: origin ? { surface: 'web', client: 'monad-web', transport: 'http', ...origin } : undefined
  }) as unknown as Session;

function outcome(session: Session): 'allowed' | HandlerError['kind'] | 'other' {
  try {
    assertSessionWriteAuthority(session);
    return 'allowed';
  } catch (error) {
    return error instanceof HandlerError ? error.kind : 'other';
  }
}

test('interactive session writes are independent of origin transport while automation stays isolated', () => {
  expect({
    acp: outcome(sessionWith({ transport: 'acp' })),
    automation: outcome(sessionWith({ surface: 'automation', transport: 'http' })),
    channel: outcome(sessionWith({ transport: 'channel' })),
    http: outcome(sessionWith({ transport: 'http' })),
    legacy: outcome(sessionWith(undefined))
  }).toEqual({
    acp: 'allowed',
    automation: 'forbidden',
    channel: 'allowed',
    http: 'allowed',
    legacy: 'allowed'
  });
});
