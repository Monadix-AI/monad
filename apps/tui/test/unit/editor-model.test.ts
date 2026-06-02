import { describe, expect, test } from 'bun:test';

import { type EditorState, edit, insertText } from '../../src/components/editor-model.ts';

describe('composer editor model', () => {
  test('inserts text at the cursor and preserves multiline paste', () => {
    const state: EditorState = { cursor: 1, value: 'ac' };
    expect(insertText(state, 'b\n')).toEqual({ cursor: 3, value: 'ab\nc' });
  });

  test('supports cursor movement and deletion', () => {
    let state: EditorState = { cursor: 3, value: 'abc' };
    state = edit(state, 'left');
    state = edit(state, 'backspace');
    expect(state).toEqual({ cursor: 1, value: 'ac' });
  });

  test('moves home and end within the current line', () => {
    expect(edit({ cursor: 5, value: 'ab\ncde\nf' }, 'home').cursor).toBe(3);
    expect(edit({ cursor: 4, value: 'ab\ncde\nf' }, 'end').cursor).toBe(6);
  });
});
