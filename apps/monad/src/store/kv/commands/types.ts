// Shared connection state + socket shape for the per-category command handlers. Lives apart from
// commands.ts so the handlers can import these types without a cycle back through the dispatcher.

export interface ConnState {
  /** Channels this connection is subscribed to → unsub callbacks. */
  subs: Map<string, () => void>;
  /** Cleanup callbacks for in-flight blocking reads (XREAD BLOCK). */
  blocked: Set<() => void>;
  /** True after the first HELLO — subsequent commands use RESP3 push for pub/sub. */
  resp3: boolean;
}

export type WriteSocket = { write(data: Buffer): void };

export function makeConnState(): ConnState {
  return { subs: new Map(), blocked: new Set(), resp3: false };
}

/** A category handler returns the reply for a command it owns (`null` = handled, reply deferred,
 *  e.g. a blocked XREAD), or `undefined` when the command isn't in its category so the dispatcher
 *  tries the next one. */
export type CommandResult = Buffer | null | undefined;
