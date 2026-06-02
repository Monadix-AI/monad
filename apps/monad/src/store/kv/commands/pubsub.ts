import type { KvStore, SubCallback } from '../store.ts';
import type { CommandResult, ConnState, WriteSocket } from './types.ts';

import { encodeArray, encodeError, encodeInteger, encodePush } from '../resp.ts';

/** Pub/sub commands. SUBSCRIBE/UNSUBSCRIBE mutate the connection's subscription set and stream
 *  messages back over RESP3 push frames; PUBLISH/PUBSUB are stateless. */
export function handlePubSubCommand(
  cmd: string | undefined,
  args: string[],
  state: ConnState,
  store: KvStore,
  socket: WriteSocket
): CommandResult {
  switch (cmd) {
    case 'SUBSCRIBE': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      const responses: Buffer[] = [];
      for (const channel of args) {
        if (!state.subs.has(channel)) {
          const cb: SubCallback = (msg) => {
            socket.write(encodePush(['message', channel, msg]));
          };
          const unsub = store.subscribe(channel, cb);
          state.subs.set(channel, unsub);
        }
        responses.push(encodePush(['subscribe', channel, state.subs.size]));
      }
      return Buffer.concat(responses);
    }

    case 'UNSUBSCRIBE': {
      const channels = args.length > 0 ? args : [...state.subs.keys()];
      const responses: Buffer[] = [];
      for (const channel of channels) {
        const unsub = state.subs.get(channel);
        if (unsub) {
          unsub();
          state.subs.delete(channel);
        }
        responses.push(encodePush(['unsubscribe', channel, state.subs.size]));
      }
      return Buffer.concat(responses);
    }

    case 'PUBLISH': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      return encodeInteger(store.publish(args[0] as string, args[1] as string));
    }

    case 'PUBSUB': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      const sub = args[0]?.toUpperCase();
      if (sub === 'NUMSUB') {
        const result: (string | null)[] = [];
        for (let i = 1; i < args.length; i++) {
          result.push(args[i] as string);
          result.push(String(store.subCount(args[i] as string)));
        }
        return encodeArray(result);
      }
      return encodeArray([]);
    }

    default:
      return undefined;
  }
}
