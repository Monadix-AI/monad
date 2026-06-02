import type { KvStore } from '../store.ts';
import type { CommandResult } from './types.ts';

import { encodeArray, encodeBulk, encodeError, encodeInteger, encodeSimple } from '../resp.ts';

/** String + counter commands (GET/SET family, MGET/MSET, APPEND/STRLEN, INCR/DECR). */
export function handleStringCommand(cmd: string | undefined, args: string[], store: KvStore): CommandResult {
  switch (cmd) {
    case 'GET': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      const val = store.get(args[0] as string);
      return encodeBulk(val);
    }

    case 'SET': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      const [key, value, ...rest] = args as [string, string, ...string[]];
      const opts: { px?: number; nx?: boolean; xx?: boolean } = {};
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i]?.toUpperCase();
        if (flag === 'NX') opts.nx = true;
        else if (flag === 'XX') opts.xx = true;
        else if (flag === 'EX' && rest[i + 1]) {
          opts.px = Number(rest[++i] as string) * 1000;
        } else if (flag === 'PX' && rest[i + 1]) {
          opts.px = Number(rest[++i] as string);
        } else if (flag === 'EXAT' && rest[i + 1]) {
          opts.px = Number(rest[++i] as string) * 1000 - Date.now();
        } else if (flag === 'PXAT' && rest[i + 1]) {
          opts.px = Number(rest[++i] as string) - Date.now();
        }
      }
      const ok = store.set(key, Buffer.from(value), opts);
      return ok ? encodeSimple('OK') : encodeBulk(null);
    }

    case 'SETNX': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      const ok = store.set(args[0] as string, Buffer.from(args[1] as string), { nx: true });
      return encodeInteger(ok ? 1 : 0);
    }

    case 'SETEX': {
      if (args.length < 3) return encodeError('wrong number of arguments');
      store.set(args[0] as string, Buffer.from(args[2] as string), { px: Number(args[1] as string) * 1000 });
      return encodeSimple('OK');
    }

    case 'PSETEX': {
      if (args.length < 3) return encodeError('wrong number of arguments');
      store.set(args[0] as string, Buffer.from(args[2] as string), { px: Number(args[1] as string) });
      return encodeSimple('OK');
    }

    case 'GETSET': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      const old = store.get(args[0] as string);
      store.set(args[0] as string, Buffer.from(args[1] as string));
      return encodeBulk(old);
    }

    case 'GETDEL': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      const val = store.get(args[0] as string);
      if (val !== null) store.del(args[0] as string);
      return encodeBulk(val);
    }

    case 'MGET': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      const vals = args.map((k) => store.get(k));
      return encodeArray(vals);
    }

    case 'MSET': {
      if (args.length < 2 || args.length % 2 !== 0) return encodeError('wrong number of arguments');
      for (let i = 0; i < args.length; i += 2) store.set(args[i] as string, Buffer.from(args[i + 1] as string));
      return encodeSimple('OK');
    }

    case 'MSETNX': {
      if (args.length < 2 || args.length % 2 !== 0) return encodeError('wrong number of arguments');
      for (let i = 0; i < args.length; i += 2) {
        if (store.get(args[i] as string) !== null) return encodeInteger(0);
      }
      for (let i = 0; i < args.length; i += 2) store.set(args[i] as string, Buffer.from(args[i + 1] as string));
      return encodeInteger(1);
    }

    case 'APPEND': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      const existing = store.get(args[0] as string) ?? Buffer.alloc(0);
      const next = Buffer.concat([existing, Buffer.from(args[1] as string)]);
      store.set(args[0] as string, next);
      return encodeInteger(next.length);
    }

    case 'STRLEN': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      const v = store.get(args[0] as string);
      return encodeInteger(v ? v.length : 0);
    }

    case 'INCR':
    case 'DECR':
    case 'INCRBY':
    case 'DECRBY': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      const raw = store.get(args[0] as string);
      const cur = raw ? Number(raw.toString()) : 0;
      if (Number.isNaN(cur)) return encodeError('value is not an integer or out of range', 'WRONGTYPE');
      let delta = 1;
      if (cmd === 'DECR') delta = -1;
      else if (cmd === 'INCRBY') delta = Number(args[1] ?? 1);
      else if (cmd === 'DECRBY') delta = -Number(args[1] ?? 1);
      const next = cur + delta;
      store.set(args[0] as string, Buffer.from(String(next)));
      return encodeInteger(next);
    }

    default:
      return undefined;
  }
}
