import type { KvStore, StreamEntry } from '../store.ts';
import type { CommandResult, ConnState, WriteSocket } from './types.ts';

import {
  encodeArray,
  encodeBulk,
  encodeError,
  encodeInteger,
  encodeNested,
  encodeNullArray,
  type RespValue
} from '../resp.ts';
import { StreamError } from '../store.ts';

/** Stream commands (XADD/XLEN/XRANGE/XREAD/XINFO). XREAD may block — see handleXread. */
export function handleStreamCommand(
  cmd: string | undefined,
  args: string[],
  state: ConnState,
  store: KvStore,
  socket: WriteSocket
): CommandResult {
  switch (cmd) {
    case 'XADD': {
      if (args.length < 4) return encodeError('wrong number of arguments');
      let i = 0;
      const key = args[i++] as string;
      const opts: { nomkstream?: boolean; maxlen?: number } = {};
      // Optional flags before the id: NOMKSTREAM, MAXLEN [~|=] count.
      for (;;) {
        const flag = args[i]?.toUpperCase();
        if (flag === 'NOMKSTREAM') {
          opts.nomkstream = true;
          i++;
        } else if (flag === 'MAXLEN') {
          i++;
          if (args[i] === '~' || args[i] === '=') i++;
          opts.maxlen = Number(args[i++] as string);
        } else {
          break;
        }
      }
      const id = args[i++] as string;
      const fields = args.slice(i);
      if (fields.length === 0 || fields.length % 2 !== 0) {
        return encodeError('wrong number of arguments for XADD');
      }
      try {
        const assigned = store.xadd(key, id, fields, opts);
        return encodeBulk(assigned);
      } catch (err) {
        if (err instanceof StreamError) return encodeError(err.message);
        throw err;
      }
    }

    case 'XLEN': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      return encodeInteger(store.xlen(args[0] as string));
    }

    case 'XRANGE':
    case 'XREVRANGE': {
      if (args.length < 3) return encodeError('wrong number of arguments');
      const [key, a, b] = args as [string, string, string];
      // XREVRANGE takes its bounds reversed (high, low) and returns descending.
      const start = cmd === 'XREVRANGE' ? b : a;
      const end = cmd === 'XREVRANGE' ? a : b;
      let count: number | undefined;
      if (args[3]?.toUpperCase() === 'COUNT' && args[4]) count = Number(args[4]);
      const entries = store.xrange(key, start, end, count);
      if (cmd === 'XREVRANGE') entries.reverse();
      return encodeNested(entries.map(entryToResp));
    }

    case 'XREAD':
      return handleXread(args, state, store, socket);

    case 'XINFO': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      const sub = args[0]?.toUpperCase();
      if (sub === 'STREAM') {
        if (args.length < 2) return encodeError('wrong number of arguments');
        const info = store.xinfoStream(args[1] as string);
        if (!info) return encodeError('no such key');
        return encodeNested([
          'length',
          info.length,
          'last-generated-id',
          info.lastGeneratedId,
          'first-entry',
          info.firstEntry ? entryToResp(info.firstEntry) : null,
          'last-entry',
          info.lastEntry ? entryToResp(info.lastEntry) : null
        ]);
      }
      // No consumer-group support — report none rather than erroring.
      if (sub === 'GROUPS' || sub === 'CONSUMERS') return encodeArray([]);
      return encodeError(`unknown XINFO subcommand '${args[0]}'`);
    }

    default:
      return undefined;
  }
}

function entryToResp(e: StreamEntry): RespValue {
  return [e.id, [...e.fields]];
}

function encodeXreadReply(results: { key: string; entries: StreamEntry[] }[]): Buffer {
  return encodeNested(results.map((r) => [r.key, r.entries.map(entryToResp)]));
}

/**
 * Non-blocking: returns matching entries, or a null array when none.
 * Blocking (BLOCK present): returns null to defer; writes to the socket when an
 * entry arrives or the timeout fires. BLOCK 0 waits indefinitely.
 */
function handleXread(args: string[], state: ConnState, store: KvStore, socket: WriteSocket): Buffer | null {
  let count: number | undefined;
  let block: number | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const tok = args[i]?.toUpperCase();
    if (tok === 'COUNT' && args[i + 1] != null) count = Number(args[++i]);
    else if (tok === 'BLOCK' && args[i + 1] != null) block = Number(args[++i]);
    else if (tok === 'STREAMS') {
      i++;
      break;
    } else return encodeError('syntax error');
  }

  const rest = args.slice(i);
  if (rest.length === 0 || rest.length % 2 !== 0) {
    return encodeError("Unbalanced XREAD list of streams: for each stream key an ID or '$' must be specified.");
  }
  const half = rest.length / 2;
  const keys = rest.slice(0, half);
  const ids = rest.slice(half);
  // Resolve `$` now (against the current top) so a blocked read waits for newer entries.
  const reqs = keys.map((key, idx) => ({
    key,
    afterId: ids[idx] === '$' ? store.lastStreamId(key) : (ids[idx] as string)
  }));

  const immediate = store.xread(reqs, count);
  if (immediate.length > 0) return encodeXreadReply(immediate);
  if (block == null) return encodeNullArray();

  // Block: defer the reply until an entry lands on one of these streams or we time out.
  let settled = false;
  let unregister = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    unregister();
    if (timer) clearTimeout(timer);
    state.blocked.delete(cleanup);
  };
  const finish = (payload: Buffer) => {
    if (settled) return;
    settled = true;
    cleanup();
    socket.write(payload);
  };

  unregister = store.addStreamWaiter(keys, () => {
    const fresh = store.xread(reqs, count);
    if (fresh.length > 0) finish(encodeXreadReply(fresh));
  });
  if (block > 0) timer = setTimeout(() => finish(encodeNullArray()), block);
  state.blocked.add(cleanup);
  return null;
}
