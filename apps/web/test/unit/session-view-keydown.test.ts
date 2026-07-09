import { expect, test } from 'bun:test';

import { createTextareaKeyDownHandler } from '../../src/features/session/session-view';

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
