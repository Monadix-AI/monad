import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('input modality bootstrap is installed before app hydration', () => {
  const layout = readSource('app/layout.tsx');

  expect(layout).toContain('input-modality-init');
  expect(layout).toContain('data-input-modality');
  expect(layout).toContain('pointerdown');
  expect(layout).toContain('keydown');
});
