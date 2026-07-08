import { Elysia } from 'elysia';

import { shutdownBus } from '#/infra/shutdown-bus.ts';

// POST /v1/daemon/stop — triggers graceful shutdown via the shutdown bus. Primarily used by
// `monad stop` on Windows where SIGTERM cannot be delivered to a detached process. On Unix,
// `monad stop` still uses SIGTERM; this endpoint is a universal fallback clients can rely on.
export function createDaemonCtlController() {
  return new Elysia().post(
    '/daemon/stop',
    () => {
      // Respond before triggering shutdown so the HTTP client receives the 200. The shutdown is
      // asynchronous (process.exit(0) runs after the response is flushed).
      setImmediate(() => shutdownBus.trigger());
      return { ok: true };
    },
    { detail: { tags: ['http-only'] } }
  );
}
