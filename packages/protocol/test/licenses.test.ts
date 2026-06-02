import { expect, test } from 'bun:test';

import { getLicensesResponseSchema } from '../src/licenses.ts';

test('license response preserves application package groups', () => {
  const response = getLicensesResponseSchema.parse({
    packages: [{ name: 'zod', version: '4.4.3', license: 'MIT' }],
    packageGroups: [
      {
        id: 'web',
        packages: [{ name: 'zod', version: '4.4.3', license: 'MIT' }]
      }
    ],
    avatarStyles: []
  });

  expect(response).toEqual({
    packages: [{ name: 'zod', version: '4.4.3', license: 'MIT' }],
    packageGroups: [
      {
        id: 'web',
        packages: [{ name: 'zod', version: '4.4.3', license: 'MIT' }]
      }
    ],
    avatarStyles: []
  });
});
