import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../../src/styles/globals.css', import.meta.url), 'utf8');

test('text-entry controls override the global interactive cursor mode', () => {
  const textCursorRule = styles.slice(
    styles.indexOf('  .monad-interactive-cursor\n    :where(\n      input:not([type])')
  );

  expect(textCursorRule).toContain('input[type="search"]');
  expect(textCursorRule).toContain('textarea');
  expect(textCursorRule).toContain('[contenteditable="true"]');
  expect(textCursorRule).toContain(':not(:disabled):not([aria-disabled="true"])');
  expect(textCursorRule).toContain('cursor: text;');
  expect(styles.indexOf('cursor: text;', styles.indexOf('.monad-interactive-cursor'))).toBeGreaterThan(
    styles.indexOf('cursor: pointer;', styles.indexOf('.monad-interactive-cursor'))
  );
});
