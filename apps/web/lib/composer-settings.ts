import type { ComposerFollowUpBehavior, ComposerSendShortcut, ComposerSettings } from '@monad/protocol';

export const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = {
  followUpBehavior: 'queue',
  sendShortcut: 'enter'
};

export type ComposerKeyIntent = {
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
  if (shortcut === 'mod-enter-for-multiline') return `${primary} + Enter for multiline prompts`;
  return `${primary} + Enter always`;
}

export function shouldSubmitComposerKey(intent: ComposerKeyIntent, shortcut: ComposerSendShortcut): boolean {
  if (intent.key !== 'Enter') return false;
  if (intent.shiftKey) return false;
  if (shortcut === 'enter') return !intent.primaryModifier;
  if (shortcut === 'mod-enter-for-multiline') return !intent.primaryModifier;
  return intent.primaryModifier;
}

export function queuedCardsForDisplay(queue: string[]): QueuedComposerCard[] {
  return queue
    .map((text, queueIndex) => ({ queueIndex, text }))
    .slice(-2)
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
