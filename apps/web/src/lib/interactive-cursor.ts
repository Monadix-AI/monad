const INTERACTIVE_CURSOR_CLASS = 'monad-interactive-cursor';
const INTERACTIVE_CURSOR_KEY = 'monad:interactiveCursor';

export function isInteractiveCursorEnabled(): boolean {
  return window.localStorage.getItem(INTERACTIVE_CURSOR_KEY) === 'true';
}

export function setInteractiveCursorEnabled(enabled: boolean): void {
  if (enabled) {
    window.localStorage.setItem(INTERACTIVE_CURSOR_KEY, 'true');
  } else {
    window.localStorage.removeItem(INTERACTIVE_CURSOR_KEY);
  }
  document.documentElement.classList.toggle(INTERACTIVE_CURSOR_CLASS, enabled);
}
