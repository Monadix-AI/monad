import { expect, test } from 'bun:test';

import { renderableIconText } from '@/lib/renderable-icon-text';

test('renderableIconText hides Hugeicons symbol names', () => {
  expect(renderableIconText('Wrench01Icon')).toBeUndefined();
  expect(renderableIconText(' Activity01Icon ')).toBeUndefined();
});

test('renderableIconText keeps user-facing text icons', () => {
  expect(renderableIconText('CG')).toBe('CG');
  expect(renderableIconText('🧠')).toBe('🧠');
  expect(renderableIconText(' https://example.com/icon.png ')).toBe('https://example.com/icon.png');
});
