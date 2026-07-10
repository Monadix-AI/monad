import { expect, test } from 'bun:test';

import { createTextareaKeyDownHandler } from '../../src/features/session/session-view';

const menuItems = [
  { insert: '/one ', key: 'one', label: '/one' },
  { insert: '/two ', key: 'two', label: '/two' }
];

function handler(overrides: Partial<Parameters<typeof createTextareaKeyDownHandler>[0]> = {}) {
  return createTextareaKeyDownHandler({
    activeSkill: 0,
    applyItem: () => {},
    followUpBehavior: 'queue',
    handleForceSteer: async () => {},
    handleQueueSubmit: async () => {},
    isBusy: false,
    menuItems: [],
    setActiveSkill: () => {},
    setSkillMenuDismissed: () => {},
    skillMenuOpen: false,
    ...overrides
  });
}

test('createTextareaKeyDownHandler accepts DOM keyboard events from ComposerEditor', () => {
  let prevented = false;
  const onKeyDown = handler({
    handleForceSteer: async () => {
      prevented = true;
    },
    isBusy: true
  });

  expect(() =>
    onKeyDown({
      ctrlKey: true,
      key: 'Enter',
      keyCode: 13,
      metaKey: true,
      preventDefault: () => {
        prevented = true;
      },
      shiftKey: false
    } as KeyboardEvent)
  ).not.toThrow();
  expect(prevented).toBe(true);
});

test('createTextareaKeyDownHandler does not apply an empty loading command menu on Enter', () => {
  let applied = false;
  let prevented = false;
  const onKeyDown = handler({
    applyItem: () => {
      applied = true;
    },
    menuItems: [],
    skillMenuOpen: true
  });

  onKeyDown({
    key: 'Enter',
    preventDefault: () => {
      prevented = true;
    }
  } as KeyboardEvent);

  expect(applied).toBe(false);
  expect(prevented).toBe(false);
});

test('createTextareaKeyDownHandler clamps command menu ArrowDown at the last item', () => {
  let nextIndex = -1;
  let prevented = false;
  const onKeyDown = handler({
    menuItems,
    setActiveSkill: (update) => {
      nextIndex = typeof update === 'function' ? update(1) : update;
    },
    skillMenuOpen: true
  });

  onKeyDown({
    key: 'ArrowDown',
    preventDefault: () => {
      prevented = true;
    }
  } as KeyboardEvent);

  expect(prevented).toBe(true);
  expect(nextIndex).toBe(1);
});

test('createTextareaKeyDownHandler clamps command menu ArrowUp at the first item', () => {
  let nextIndex = -1;
  let prevented = false;
  const onKeyDown = handler({
    menuItems,
    setActiveSkill: (update) => {
      nextIndex = typeof update === 'function' ? update(0) : update;
    },
    skillMenuOpen: true
  });

  onKeyDown({
    key: 'ArrowUp',
    preventDefault: () => {
      prevented = true;
    }
  } as KeyboardEvent);

  expect(prevented).toBe(true);
  expect(nextIndex).toBe(0);
});
