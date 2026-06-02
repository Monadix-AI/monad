import { expect, test } from 'bun:test';

import { composerCanSend, selectedComposerFiles } from '../../src/features/session/ComposerShell.tsx';

test('composer sendability accepts attachment-only drafts and preserves disabled states', () => {
  expect({
    attachmentOnly: composerCanSend({
      attachmentCount: 1,
      disabled: false,
      text: '',
      voiceActive: false
    }),
    disabled: composerCanSend({
      attachmentCount: 1,
      disabled: true,
      text: '',
      voiceActive: false
    }),
    empty: composerCanSend({
      attachmentCount: 0,
      disabled: false,
      text: '',
      voiceActive: false
    }),
    text: composerCanSend({
      attachmentCount: 0,
      disabled: false,
      text: 'hello',
      voiceActive: false
    }),
    voiceActive: composerCanSend({
      attachmentCount: 1,
      disabled: false,
      text: '',
      voiceActive: true
    })
  }).toEqual({
    attachmentOnly: true,
    disabled: false,
    empty: false,
    text: true,
    voiceActive: false
  });
});

test('composer file selection preserves browser order and handles a cleared input', () => {
  const first = new File(['a'], 'a.txt', { type: 'text/plain' });
  const second = new File(['b'], 'b.txt', { type: 'text/plain' });
  const files = {
    0: first,
    1: second,
    item: (index: number) => [first, second][index] ?? null,
    length: 2
  } as unknown as FileList;

  expect({
    cleared: selectedComposerFiles(null),
    selected: selectedComposerFiles(files).map((file) => file.name)
  }).toEqual({
    cleared: [],
    selected: ['a.txt', 'b.txt']
  });
});
