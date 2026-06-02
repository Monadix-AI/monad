import type { KvStore } from '../store.ts';
import type { CommandResult } from './types.ts';

import { encodeArray, encodeBulk, encodeInteger, encodeMap, encodeSimple } from '../resp.ts';

/** Connection + server-admin commands: handshake (HELLO/PING/QUIT/SELECT), introspection
 *  (INFO/COMMAND), keyspace admin (DBSIZE/FLUSHDB/FLUSHALL), and accepted-but-ignored no-ops. */
export function handleServerCommand(cmd: string | undefined, args: string[], store: KvStore): CommandResult {
  switch (cmd) {
    case 'PING':
      return args.length > 0 ? encodeBulk(args[0] as string) : encodeSimple('PONG');

    case 'HELLO':
      // Respond with a RESP3 map so Bun.redis proceeds in RESP3 mode. The connection's resp3 flag
      // is flipped by the dispatcher, which owns ConnState.
      return encodeMap([
        ['server', 'monad-kv'],
        ['version', '1.0.0'],
        ['proto', 3],
        ['id', 1],
        ['mode', 'standalone'],
        ['role', 'master'],
        ['modules', null]
      ]);

    case 'QUIT':
      return encodeSimple('OK');

    case 'DBSIZE':
      return encodeInteger(store.dbsize());

    case 'FLUSHDB':
    case 'FLUSHALL':
      store.flush();
      return encodeSimple('OK');

    case 'SELECT':
      // Single database — just acknowledge.
      return encodeSimple('OK');

    case 'INFO': {
      const info = [
        '# Server',
        'redis_version:7.0.0',
        'redis_mode:standalone',
        '',
        '# Keyspace',
        `db0:keys=${store.dbsize()},expires=0,avg_ttl=0`
      ].join('\r\n');
      return encodeBulk(info);
    }

    case 'COMMAND':
      return encodeArray([]);

    case 'DEBUG':
    case 'LATENCY':
    case 'RESET':
    case 'CONFIG':
      return encodeSimple('OK');

    default:
      return undefined;
  }
}
