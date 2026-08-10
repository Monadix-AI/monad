import { expect, test } from 'bun:test';

import { scrollShadowVisibility } from '../../src/components/ScrollShadow.tsx';

test('scroll shadow visibility follows the remaining vertical overflow', () => {
  expect([
    scrollShadowVisibility({ clientHeight: 100, scrollHeight: 100, scrollTop: 0 }),
    scrollShadowVisibility({ clientHeight: 100, scrollHeight: 300, scrollTop: 0 }),
    scrollShadowVisibility({ clientHeight: 100, scrollHeight: 300, scrollTop: 80 }),
    scrollShadowVisibility({ clientHeight: 100, scrollHeight: 300, scrollTop: 200 })
  ]).toEqual(['none', 'bottom', 'both', 'top']);
});
