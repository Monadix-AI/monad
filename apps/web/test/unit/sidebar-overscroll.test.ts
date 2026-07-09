import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('web shell disables horizontal overscroll navigation gestures', () => {
  const css = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8');

  expect(css).toContain('overscroll-behavior-x: none');
});
