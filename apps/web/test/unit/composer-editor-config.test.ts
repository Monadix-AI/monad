import { expect, test } from 'bun:test';
import { COMPOSER_EDITOR_IMMEDIATELY_RENDER } from '@monad/ui/components/ComposerEditor';

test('ComposerEditor opts into immediate client rendering for Tiptap under Next', () => {
  expect(COMPOSER_EDITOR_IMMEDIATELY_RENDER).toBe(true);
});
