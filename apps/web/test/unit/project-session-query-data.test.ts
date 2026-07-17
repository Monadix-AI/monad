import { expect, test } from 'bun:test';

import { projectSessionCurrentData } from '../../src/features/workplace/use-project';

test('project session queries hide the previous session while the routed session has no data', () => {
  const previousSession = { items: [{ id: 'msg_previous', role: 'user' }] };

  expect(
    projectSessionCurrentData({ data: previousSession } as { currentData?: typeof previousSession })
  ).toBeUndefined();
});
