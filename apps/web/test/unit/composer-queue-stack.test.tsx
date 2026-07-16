import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ComposerQueueStack } from '../../src/features/session/ComposerQueueStack.tsx';

test('queue stack renders three depth cards and a hidden-scrollbar expanded list', () => {
  const markup = renderToStaticMarkup(
    createElement(ComposerQueueStack, {
      cancelLabel: 'Cancel',
      items: ['first', 'second', 'third', 'fourth'],
      onCancel: () => {},
      onRemove: () => {},
      onSteerNow: () => {},
      steerNowLabel: 'Steer now'
    })
  );

  expect(markup).toContain('Steer now</button>');
  expect(markup).toContain('>Cancel</button>');
  expect(markup).toContain('size-3.5');
  expect(markup).toContain('first');
  expect(markup.match(/data-slot="composer-queue-stack-card"/g)).toHaveLength(3);
  expect(markup.match(/data-slot="composer-queue-expanded-card"/g)).toHaveLength(4);
  expect(markup).toContain('max-h-60');
  expect(markup).toContain('line-clamp-5');
  expect(markup).not.toContain('min-h-14');
  expect(markup).toContain('bg-transparent');
  expect(markup).toContain('overflow-x-hidden');
  expect(markup).not.toContain('overflow-x-auto');
  expect(markup).toContain('[scrollbar-width:none]');
  expect(markup).toContain('[&amp;::-webkit-scrollbar]:hidden');
  expect(markup).toContain('bottom-5');
});
