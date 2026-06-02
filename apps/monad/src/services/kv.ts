import type { KvServer } from '@/store/kv/index.ts';

type RedisClient = InstanceType<typeof Bun.RedisClient>;

export function createKvService(server: KvServer, client: RedisClient) {
  return {
    get: (key: string) => client.get(key),
    set: (key: string, value: string, opts?: { px?: number; ex?: number }) => {
      if (opts?.px != null) return client.psetex(key, opts.px, value);
      if (opts?.ex != null) return client.setex(key, opts.ex, value);
      return client.set(key, value);
    },
    del: (...keys: string[]) => client.del(...keys),
    keys: (pattern: string) => client.keys(pattern),
    mget: (...keys: string[]) => client.mget(...keys),
    mset: (entries: [string, string][]) => client.mset(...entries.flat()),
    // Bun.redis has no flushdb — call store.flush() directly
    flush: () => {
      server.store.flush();
      return Promise.resolve('OK' as const);
    },
    publish: (channel: string, message: string) => client.publish(channel, message),
    ttl: (key: string) => client.ttl(key),
    pttl: (key: string) => client.pttl(key),
    expire: (key: string, seconds: number) => client.expire(key, seconds),
    pexpire: (key: string, ms: number) => client.pexpire(key, ms)
  };
}

export type KvService = ReturnType<typeof createKvService>;
