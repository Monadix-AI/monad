import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../../src/styles/globals.css', import.meta.url), 'utf8');

test('disabled composer editor keeps the shared surface visible without an opaque block', () => {
  const selector = '.composer-editor-input[contenteditable="false"]';
  const ruleStart = styles.indexOf(selector);
  const ruleEnd = styles.indexOf('}', ruleStart);
  const rule = styles.slice(ruleStart, ruleEnd + 1);

  expect(rule).toContain('background: transparent;');
  expect(rule).not.toContain('background: color-mix(');
});
