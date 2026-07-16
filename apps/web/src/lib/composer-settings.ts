import type { ComposerFollowUpBehavior, ComposerSendShortcut, ComposerSettings } from '@monad/protocol';

export const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = {
  followUpBehavior: 'queue',
  sendShortcut: 'enter'
};
export const LONG_PROMPT_CHARACTER_THRESHOLD = 160;

export type ComposerKeyIntent = {
  characterCount?: number;
  hasMultipleLines?: boolean;
  key: string;
  primaryModifier: boolean;
  shiftKey: boolean;
};

export type QueuedComposerCard = {
  displayIndex: number;
  queueIndex: number;
  text: string;
};

export function composerShortcutLabel(shortcut: ComposerSendShortcut, isApple: boolean): string {
  const primary = isApple ? '⌘' : 'Ctrl';
  if (shortcut === 'enter') return 'Enter';
  if (shortcut === 'mod-enter-for-multiline') return `${primary} + Enter for long prompts`;
  return `${primary} + Enter always`;
}

export function shouldSubmitComposerKey(intent: ComposerKeyIntent, shortcut: ComposerSendShortcut): boolean {
  if (intent.key !== 'Enter') return false;
  if (intent.shiftKey) return false;
  if (shortcut === 'enter') return !intent.primaryModifier;
  if (shortcut === 'mod-enter-for-multiline') {
    const longPrompt =
      Boolean(intent.hasMultipleLines) || (intent.characterCount ?? 0) >= LONG_PROMPT_CHARACTER_THRESHOLD;
    return longPrompt ? intent.primaryModifier : !intent.primaryModifier;
  }
  return intent.primaryModifier;
}

export function queuedCardsForDisplay(queue: string[]): QueuedComposerCard[] {
  return queue
    .map((text, queueIndex) => ({ queueIndex, text }))
    .slice(-3)
    .reverse()
    .map((card, displayIndex) => ({ displayIndex, ...card }));
}

export function normalizedComposerSettings(settings: Partial<ComposerSettings> | null | undefined): ComposerSettings {
  return {
    followUpBehavior: normalizeFollowUpBehavior(settings?.followUpBehavior),
    sendShortcut: normalizeSendShortcut(settings?.sendShortcut)
  };
}

function normalizeFollowUpBehavior(value: ComposerFollowUpBehavior | undefined): ComposerFollowUpBehavior {
  return value === 'steer' ? 'steer' : DEFAULT_COMPOSER_SETTINGS.followUpBehavior;
}

function normalizeSendShortcut(value: ComposerSendShortcut | undefined): ComposerSendShortcut {
  if (value === 'mod-enter-for-multiline' || value === 'mod-enter-always') return value;
  return DEFAULT_COMPOSER_SETTINGS.sendShortcut;
}
