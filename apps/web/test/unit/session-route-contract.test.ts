import { describe, expect, test } from 'bun:test';

import { SESSION_ROUTE_MODEL_REGIONS } from '../../src/features/session/session-route-contract';

describe('session route contract', () => {
  test('exposes focused identity, transcript, composer, and inspector regions', () => {
    expect(SESSION_ROUTE_MODEL_REGIONS).toEqual(['identity', 'transcript', 'composer', 'inspector']);
  });
});
