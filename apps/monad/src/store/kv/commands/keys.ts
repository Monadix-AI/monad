import type { KvStore } from '../store.ts';
import type { CommandResult } from './types.ts';

import { encodeArray, encodeBulk, encodeError, encodeInteger, encodeSimple } from '../resp.ts';

/** Generic key-space commands: deletion, existence, expiry, type, rename, enumeration (KEYS/SCAN). */
export function handleKeyCommand(cmd: string | undefined, args: string[], store: KvStore): CommandResult {
  switch (cmd) {
    case 'DEL':
    case 'UNLINK': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      return encodeInteger(store.del(...args));
    }

    case 'EXISTS': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      return encodeInteger(store.exists(...args));
    }

    case 'EXPIRE': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      return encodeInteger(store.expire(args[0] as string, Number(args[1] as string)) ? 1 : 0);
    }

    case 'PEXPIRE': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      return encodeInteger(store.pexpire(args[0] as string, Number(args[1] as string)) ? 1 : 0);
    }

    case 'EXPIREAT': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      const ms = Number(args[1] as string) * 1000 - Date.now();
      return encodeInteger(store.pexpire(args[0] as string, Math.max(0, ms)) ? 1 : 0);
    }

    case 'PEXPIREAT': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      const ms = Number(args[1] as string) - Date.now();
      return encodeInteger(store.pexpire(args[0] as string, Math.max(0, ms)) ? 1 : 0);
    }

    case 'TTL':
      if (args.length < 1) return encodeError('wrong number of arguments');
      return encodeInteger(store.ttl(args[0] as string));

    case 'PTTL':
      if (args.length < 1) return encodeError('wrong number of arguments');
      return encodeInteger(store.pttl(args[0] as string));

    case 'PERSIST':
      if (args.length < 1) return encodeError('wrong number of arguments');
      return encodeInteger(store.persist(args[0] as string) ? 1 : 0);

    case 'TYPE': {
      if (args.length < 1) return encodeError('wrong number of arguments');
      return encodeSimple(store.type(args[0] as string));
    }

    case 'RENAME': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      const v = store.get(args[0] as string);
      if (v === null) return encodeError('no such key');
      store.del(args[0] as string);
      store.set(args[1] as string, v);
      return encodeSimple('OK');
    }

    case 'RENAMENX': {
      if (args.length < 2) return encodeError('wrong number of arguments');
      const v = store.get(args[0] as string);
      if (v === null) return encodeError('no such key');
      if (store.get(args[1] as string) !== null) return encodeInteger(0);
      store.del(args[0] as string);
      store.set(args[1] as string, v);
      return encodeInteger(1);
    }

    case 'KEYS': {
      const pattern = args[0] ?? '*';
      return encodeArray(store.keys(pattern));
    }

    case 'SCAN': {
      // Cursor is a numeric offset into the full key list (not a server-side cursor).
      const pattern = extractScanPattern(args);
      const count = extractScanCount(args);
      const allKeys = store.keys(pattern);
      const cursor = args[0] ? Number(args[0]) : 0;
      const page = allKeys.slice(cursor, cursor + count);
      const nextCursor = cursor + count >= allKeys.length ? 0 : cursor + count;
      return Buffer.concat([Buffer.from(`*2${'\r\n'}`), encodeBulk(String(nextCursor)), encodeArray(page)]);
    }

    case 'RANDOMKEY': {
      const all = store.keys('*');
      if (all.length === 0) return encodeBulk(null);
      return encodeBulk(all[Math.floor(Math.random() * all.length)] as string);
    }

    default:
      return undefined;
  }
}

function extractScanPattern(args: string[]): string {
  for (let i = 1; i < args.length - 1; i++) {
    if (args[i]?.toUpperCase() === 'MATCH') return args[i + 1] as string;
  }
  return '*';
}

function extractScanCount(args: string[]): number {
  for (let i = 1; i < args.length - 1; i++) {
    if (args[i]?.toUpperCase() === 'COUNT') return Number(args[i + 1] as string) || 100;
  }
  return 100;
}
