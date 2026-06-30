import { expect, test } from 'bun:test';

import { STUDIO_SECTION_COMPONENTS } from '../../features/studio/section-registry';
import { STUDIO_SECTION_IDS } from '../../features/studio/sections';

test('studio section registry covers every studio section id', () => {
  expect(Object.keys(STUDIO_SECTION_COMPONENTS).sort()).toEqual([...STUDIO_SECTION_IDS].sort());
});
