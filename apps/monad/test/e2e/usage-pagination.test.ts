// e2e: GET /v1/usage paginates its day/provider/model/category breakdown with
// offsetPaginationQuerySchema/offsetPaginationResponseSchema, over both transports.

import type { GetUsageResponse } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

for (const kind of TRANSPORTS) {
  describe(`usage pagination over ${kind}`, () => {
    let t: TransportHandle;
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
      store = createStore();
      store.recordLedger('anthropic', 'claude-x', 'chat', { inputTokens: 100, outputTokens: 50 }, 0.01);
      store.recordLedger('openai', 'gpt-x', 'chat', { inputTokens: 10, outputTokens: 5 }, 0.001);
      store.recordLedger('openai', 'gpt-x', 'embedding', { inputTokens: 1 }, 0.0001);
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(), undefined, { store })));
    });

    afterEach(async () => {
      await t.stop();
      store.close();
    });

    test('unpaginated request returns the full breakdown with total/limit/offset', async () => {
      const res = await t.fetch('/v1/usage');
      expect(res.status).toBe(200);
      const body = (await res.json()) as GetUsageResponse;
      expect(body.breakdown.length).toBe(3);
      expect(body.total).toBe(3);
      expect(body.offset).toBe(0);
      expect(body.limit).toBeGreaterThanOrEqual(3);
      // totals are computed over the whole ledger, independent of the breakdown page
      expect(body.totalInputTokens).toBe(111);
    });

    test('limit/offset slice the breakdown while total reflects the full set', async () => {
      const res = await t.fetch('/v1/usage?limit=1&offset=1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as GetUsageResponse;
      expect(body.breakdown.length).toBe(1);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(1);
    });
  });
}
