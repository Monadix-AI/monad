export interface EditorState {
  cursor: number;
  value: string;
}

export type EditorCommand = 'backspace' | 'delete' | 'left' | 'right' | 'home' | 'end';

export function insertText(state: EditorState, text: string): EditorState {
  return {
    cursor: state.cursor + text.length,
    value: `${state.value.slice(0, state.cursor)}${text}${state.value.slice(state.cursor)}`
  };
}

export function edit(state: EditorState, command: EditorCommand): EditorState {
  switch (command) {
    case 'left':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'right':
      return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };
    case 'backspace':
      if (state.cursor === 0) return state;
      return {
        cursor: state.cursor - 1,
        value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor)
      };
    case 'delete':
      if (state.cursor >= state.value.length) return state;
      return { ...state, value: state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1) };
    case 'home': {
      const previousLine = state.value.lastIndexOf('\n', Math.max(0, state.cursor - 1));
      return { ...state, cursor: previousLine + 1 };
    }
    case 'end': {
      const nextLine = state.value.indexOf('\n', state.cursor);
      return { ...state, cursor: nextLine < 0 ? state.value.length : nextLine };
    }
  }
}
