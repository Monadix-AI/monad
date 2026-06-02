// RESP command dispatch. The protocol surface is large, so each data-category lives in its own
// module under ./commands/ (strings, keys, streams, pubsub, server). handleCommand parses the
// command name once and tries each category in turn: a handler returns the reply for a command it
// owns, `null` when it handled the command but the reply is deferred (a blocked XREAD), or
// `undefined` when the command isn't its — so the dispatcher moves on, falling through to the
// unknown-command error only when no category claims it.

import type { ConnState, WriteSocket } from './commands/types.ts';
import type { KvStore } from './store.ts';

import { handleKeyCommand } from './commands/keys.ts';
import { handlePubSubCommand } from './commands/pubsub.ts';
import { handleServerCommand } from './commands/server.ts';
import { handleStreamCommand } from './commands/streams.ts';
import { handleStringCommand } from './commands/strings.ts';
import { encodeError } from './resp.ts';

export { type ConnState, makeConnState, type WriteSocket } from './commands/types.ts';

export function handleCommand(rawArgs: string[], state: ConnState, store: KvStore, socket: WriteSocket): Buffer | null {
  if (rawArgs.length === 0) return encodeError('no command');

  const cmd = rawArgs[0]?.toUpperCase();
  const args = rawArgs.slice(1);

  // HELLO upgrades the connection to RESP3 for subsequent pub/sub push frames; the server handler
  // builds the reply but the dispatcher owns ConnState, so flip the flag here.
  if (cmd === 'HELLO') state.resp3 = true;

  // Each handler returns undefined for a command outside its category; stop at the first that owns
  // it (a `null` return is "owned, reply deferred" and must short-circuit too).
  const server = handleServerCommand(cmd, args, store);
  if (server !== undefined) return server;
  const string = handleStringCommand(cmd, args, store);
  if (string !== undefined) return string;
  const key = handleKeyCommand(cmd, args, store);
  if (key !== undefined) return key;
  const stream = handleStreamCommand(cmd, args, state, store, socket);
  if (stream !== undefined) return stream;
  const pubsub = handlePubSubCommand(cmd, args, state, store, socket);
  if (pubsub !== undefined) return pubsub;

  return encodeError(`unknown command \`${cmd}\`, with args beginning with: `, 'ERR');
}
