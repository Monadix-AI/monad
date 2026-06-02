import { expect, test } from 'bun:test';

import {
  acquireGlobalKeyboardInput,
  globalKeyboardInputCaptureScope,
  isGlobalKeyboardInputCaptured,
  resetGlobalKeyboardInputCapturesForTest
} from '../../src/lib/global-keyboard-input-capture.ts';

function element(id: string): HTMLElement {
  return { id } as HTMLElement;
}

test('global keyboard input capture uses the newest owner and releases in any order', () => {
  resetGlobalKeyboardInputCapturesForTest();
  const first = element('first');
  const second = element('second');

  const releaseFirst = acquireGlobalKeyboardInput(first);
  const releaseSecond = acquireGlobalKeyboardInput(second);

  expect({
    captured: isGlobalKeyboardInputCaptured(),
    scope: globalKeyboardInputCaptureScope()?.id
  }).toEqual({ captured: true, scope: 'second' });

  releaseFirst();
  expect({
    captured: isGlobalKeyboardInputCaptured(),
    scope: globalKeyboardInputCaptureScope()?.id
  }).toEqual({ captured: true, scope: 'second' });

  releaseSecond();
  expect({
    captured: isGlobalKeyboardInputCaptured(),
    scope: globalKeyboardInputCaptureScope()
  }).toEqual({ captured: false, scope: null });
});
