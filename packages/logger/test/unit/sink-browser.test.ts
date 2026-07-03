import { describe, expect, test } from 'bun:test';
import { developerLogRecordSchema } from '@monad/protocol';

import { subscribeDeveloperLogRecords } from '../../src/developer.ts';
import { createLogger } from '../../src/sink.browser.ts';

// Assertions read the fanned-out developer records, not the console — so the sink's own console
// output is harmless test noise and needs no silencing.

/** Capture developer records emitted during `run`. */
function capture(run: () => void): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const unsub = subscribeDeveloperLogRecords((r) => records.push(r as Record<string, unknown>));
  try {
    run();
  } finally {
    unsub();
  }
  return records;
}

describe('browser sink developer records', () => {
  test('emit a numeric level + time that satisfy the developer-log wire schema', () => {
    const log = createLogger('web');
    const records = capture(() => log.info({ sessionId: 'ses_1' }, 'hello'));
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(typeof rec?.level).toBe('number'); // NOT the string 'info'
    expect(rec?.level).toBe(30);
    expect(typeof rec?.time).toBe('number');
    // The record must parse against the same schema the node sink's records do.
    expect(developerLogRecordSchema.safeParse(rec).success).toBe(true);
  });

  test('preserve an Error object message/stack instead of spreading to {}', () => {
    // sessionId binding so the record is fanned out; the point is the Error's fields survive.
    const log = createLogger('web', { sessionId: 'ses_1' });
    const records = capture(() => log.error(new Error('boom')));
    expect(records).toHaveLength(1);
    const rec = records[0] as { msg?: string; err?: { message?: string; stack?: string; type?: string } };
    expect(rec.msg).toBe('boom');
    expect(rec.err?.message).toBe('boom');
    expect(rec.err?.type).toBe('Error');
    expect(typeof rec.err?.stack).toBe('string');
  });

  test('fan out debug records to subscribers even when the console threshold is info', () => {
    const log = createLogger('web'); // default threshold = info (30)
    const debugRecords = capture(() => log.debug({ sessionId: 'ses_1' }, 'below console threshold'));
    expect(debugRecords).toHaveLength(1); // reaches subscribers despite being below info
    expect(debugRecords[0]?.level).toBe(20);
  });

  test('do NOT fan out trace records (below the debug developer floor, matching node)', () => {
    const log = createLogger('web');
    const traceRecords = capture(() => log.trace({ sessionId: 'ses_1' }, 'too low'));
    expect(traceRecords).toHaveLength(0);
  });

  test('only records carrying a channelId/sessionId are fanned out', () => {
    const log = createLogger('web');
    const records = capture(() => log.info('no ids here'));
    expect(records).toHaveLength(0);
  });
});
