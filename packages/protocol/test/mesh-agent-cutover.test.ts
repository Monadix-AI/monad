import type { z } from 'zod';

import { expect, test } from 'bun:test';

import * as protocol from '../src/index.ts';

type Schema = z.ZodType;

const meshContracts = protocol as unknown as {
  meshConvenienceFrameSchema: Schema;
  meshEventPageRequestSchema: Schema;
  meshRawEventSchema: Schema;
  meshSessionIdSchema: Schema;
};

test('MeshSession ids use the mesh prefix and reject the removed exa prefix', () => {
  expect({
    mesh: meshContracts.meshSessionIdSchema.safeParse('mesh_123456789012').success,
    legacyIdAccepted: meshContracts.meshSessionIdSchema.safeParse('exa_123456789012').success
  }).toEqual({ mesh: true, legacyIdAccepted: false });
});

test('Mesh raw events use MeshSession identity and events origin', () => {
  expect(
    meshContracts.meshRawEventSchema.parse({
      meshSessionId: 'mesh_123456789012',
      provider: 'codex',
      origin: 'events',
      cursor: 'provider:cursor_1',
      data: { type: 'message' }
    })
  ).toEqual({
    meshSessionId: 'mesh_123456789012',
    provider: 'codex',
    origin: 'events',
    cursor: 'provider:cursor_1',
    data: { type: 'message' }
  });
});

test('Mesh event pages select raw or convenience without exposing provider storage', () => {
  expect(
    meshContracts.meshEventPageRequestSchema.parse({
      view: 'convenience',
      before: 'provider:cursor_1',
      limit: 20
    })
  ).toEqual({ view: 'convenience', before: 'provider:cursor_1', limit: 20 });

  expect(
    meshContracts.meshConvenienceFrameSchema.parse({
      kind: 'ready',
      observationEpoch: 'epoch_1',
      eventsBefore: 'provider:cursor_1',
      cursor: 'live:epoch_1:0'
    })
  ).toEqual({
    kind: 'ready',
    observationEpoch: 'epoch_1',
    eventsBefore: 'provider:cursor_1',
    cursor: 'live:epoch_1:0'
  });
});

test('Mesh event pages preserve a comma-bearing provider cursor split by the HTTP parser', () => {
  const cursor = 'provider:{"turnId":"019f741c-70a5-7df2-a5f4-04132750aace","includeAnchor":false}';

  expect(
    meshContracts.meshEventPageRequestSchema.parse({
      view: 'convenience',
      before: ['provider:{"turnId":"019f741c-70a5-7df2-a5f4-04132750aace"', '"includeAnchor":false}'],
      limit: '20'
    })
  ).toEqual({ view: 'convenience', before: cursor, limit: 20 });
});
