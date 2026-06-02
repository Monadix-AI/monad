import type { EventCursor, EventId } from '@monad/protocol';
import type { HandlerErrorKind } from '#/handlers/handler-error.ts';

import { eventCursorSchema, eventIdSchema } from '@monad/protocol';
import { z } from 'zod';

import { HandlerError } from '#/handlers/handler-error.ts';

type ReplayPlane = 'session.events' | 'session.ui';

export interface ReplayScope {
  plane: ReplayPlane;
  transcriptTargetId: string;
}

export interface DecodedEventCursor extends ReplayScope {
  anchorEventId: EventId;
}

export type ResolvedReplayCursor =
  | { tier: 'live'; anchorEventId: EventId }
  | { tier: 'durable'; anchorEventId: EventId };

type EventCursorErrorReason = 'invalid' | 'wrong_scope' | 'expired';

const ERROR_DEFINITIONS: Record<EventCursorErrorReason, { kind: HandlerErrorKind; code: string; message: string }> = {
  invalid: { kind: 'invalid', code: 'CURSOR_INVALID', message: 'event cursor is invalid' },
  wrong_scope: { kind: 'conflict', code: 'CURSOR_WRONG_SCOPE', message: 'event cursor has the wrong scope' },
  expired: { kind: 'gone', code: 'CURSOR_EXPIRED', message: 'event cursor has expired' }
};

export class EventCursorError extends HandlerError {
  readonly retryable = false;

  constructor(reason: EventCursorErrorReason) {
    const definition = ERROR_DEFINITIONS[reason];
    super(definition.kind, definition.message, definition.code);
    this.name = 'EventCursorError';
  }
}

const encodedCursorSchema = z.strictObject({
  v: z.literal(1),
  p: z.enum(['session.events', 'session.ui']),
  s: z.string().min(1).max(512),
  a: eventIdSchema
});

export function encodeEventCursor(scope: ReplayScope, anchorEventId: EventId): EventCursor {
  const payload = encodedCursorSchema.safeParse({
    v: 1,
    p: scope.plane,
    s: scope.transcriptTargetId,
    a: anchorEventId
  });
  if (!payload.success) throw new EventCursorError('invalid');
  const encoded = Buffer.from(JSON.stringify(payload.data)).toString('base64url');
  const parsed = eventCursorSchema.safeParse(`cur_${encoded}`);
  if (!parsed.success) throw new EventCursorError('invalid');
  return parsed.data;
}

export function decodeEventCursor(cursor: EventCursor, expected: ReplayScope): DecodedEventCursor {
  const parsedCursor = eventCursorSchema.safeParse(cursor);
  if (!parsedCursor.success) throw new EventCursorError('invalid');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parsedCursor.data.slice(4), 'base64url').toString('utf8'));
  } catch {
    throw new EventCursorError('invalid');
  }
  const parsed = encodedCursorSchema.safeParse(decoded);
  if (!parsed.success) throw new EventCursorError('invalid');
  if (parsed.data.p !== expected.plane || parsed.data.s !== expected.transcriptTargetId) {
    throw new EventCursorError('wrong_scope');
  }
  return {
    plane: parsed.data.p,
    transcriptTargetId: parsed.data.s,
    anchorEventId: parsed.data.a
  };
}

interface ReplayCursorStore {
  eventAnchorStatus(scope: string, eventId: EventId): 'durable' | 'other_scope' | 'missing';
}

interface ReplayCursorCache {
  anchorStatus(scope: string, eventId: EventId): 'live' | 'other_scope' | 'missing';
}

export function resolveReplayCursor(
  cursor: string,
  expected: ReplayScope,
  deps: { store: ReplayCursorStore; cache: ReplayCursorCache }
): ResolvedReplayCursor {
  let anchorEventId: EventId;
  if (cursor.startsWith('cur_')) {
    anchorEventId = decodeEventCursor(cursor as EventCursor, expected).anchorEventId;
  } else {
    const parsed = eventIdSchema.safeParse(cursor);
    if (!parsed.success) throw new EventCursorError('invalid');
    anchorEventId = parsed.data;
  }

  const live = deps.cache.anchorStatus(expected.transcriptTargetId, anchorEventId);
  if (live === 'live') return { tier: 'live', anchorEventId };
  if (live === 'other_scope') throw new EventCursorError('wrong_scope');

  const durable = deps.store.eventAnchorStatus(expected.transcriptTargetId, anchorEventId);
  if (durable === 'durable') return { tier: 'durable', anchorEventId };
  if (durable === 'other_scope') throw new EventCursorError('wrong_scope');
  throw new EventCursorError('expired');
}
