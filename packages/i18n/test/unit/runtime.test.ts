import type { LocalePack } from '../../src/index.ts';

import { describe, expect, test } from 'bun:test';

import { buildCatalog, buildCatalogOverlay, createI18n } from '../../src/index.ts';
import {
  buildBuiltinCatalog,
  enMessages as builtinEnMessages,
  zhMessages as builtinZhMessages
} from '../../src/messages.ts';

const enMessages: Record<string, string> = {
  'cmd.switch.done': '➡️ Switched to {{label}}.',
  'cmd.switch.usage': 'Usage: /switch <number|session-id>',
  'cmd.reset.done_one': '🧹 Cleared {{count}} message.',
  'cmd.reset.done_other': '🧹 Cleared {{count}} messages.',
  'cmd.compact.done': '🗜 Compacted.',
  'cmd.new.started': '🆕 Started a new conversation.'
};

const en: LocalePack = { locale: 'en', name: 'English', messages: enMessages };
const zh: LocalePack = {
  locale: 'zh',
  name: '中文',
  messages: {
    'cmd.new.started': '🆕 已开始新的对话。',
    'cmd.reset.done_other': '🧹 已清除 {{count}} 条消息。',
    'channel.error': '⚠ 错误：{{label}}'
    // intentionally missing 'cmd.compact.done' to exercise the fallback chain
  }
};

describe('createI18n (Paraglide-backed runtime)', () => {
  test('built-in messages work without runtime packs', () => {
    const { t } = createI18n({ locale: 'zh', packs: [] });
    expect(t('cmd.new.started')).toBe(builtinZhMessages['cmd.new.started'] ?? '');
  });

  test('named {{var}} interpolation', () => {
    const { t } = createI18n({ locale: 'en', packs: [en] });
    expect(t('cmd.switch.done', { label: 'Alpha' })).toBe('➡️ Switched to Alpha.');
  });

  test('english plural via _one/_other suffix + {{count}}', () => {
    const { t } = createI18n({ locale: 'en', packs: [en] });
    expect(t('cmd.reset.done', { count: 1 })).toBe('🧹 Cleared 1 message.');
    expect(t('cmd.reset.done', { count: 3 })).toBe('🧹 Cleared 3 messages.');
  });

  test('chinese has only the other plural category', () => {
    const { t } = createI18n({ locale: 'zh', packs: [en, zh] });
    expect(t('cmd.reset.done', { count: 1 })).toBe('🧹 已清除 1 条消息。');
    expect(t('cmd.reset.done', { count: 5 })).toBe('🧹 已清除 5 条消息。');
  });

  test('HTML is not escaped (terminal/Telegram/React output)', () => {
    const { t } = createI18n({ locale: 'en', packs: [en] });
    expect(t('cmd.switch.usage')).toBe('Usage: /switch <number|session-id>');
  });

  test('runtime packs can override built-in keys', () => {
    const { t } = createI18n({
      locale: 'en',
      packs: [{ locale: 'en', name: 'English', messages: { 'cmd.new.started': 'Override {{label}}' } }]
    });
    expect(t('cmd.new.started', { label: 'OK' })).toBe('Override OK');
  });
});

describe('fallback chain', () => {
  test('active locale wins', () => {
    const { t } = createI18n({ locale: 'zh', packs: [en, zh] });
    expect(t('cmd.new.started')).toBe('🆕 已开始新的对话。');
  });

  test('missing key in active locale falls back to en', () => {
    const { t } = createI18n({ locale: 'zh', packs: [en, zh] });
    expect(t('cmd.compact.done')).toBe(enMessages['cmd.compact.done'] ?? '');
  });

  test('unknown locale falls back to canonical english', () => {
    const { t } = createI18n({ locale: 'fr', packs: [en, zh] });
    expect(t('cmd.new.started')).toBe(enMessages['cmd.new.started'] ?? '');
  });

  test('unknown id returns the id itself', () => {
    const { t } = createI18n({ locale: 'en', packs: [en] });
    expect(t('totally.unknown.id')).toBe('totally.unknown.id');
  });
});

describe('buildCatalog (raw templates for the web)', () => {
  test('built-in catalog construction is cached per locale fallback pair', () => {
    expect(buildBuiltinCatalog('en')).toBe(buildBuiltinCatalog('en'));
    expect(buildBuiltinCatalog('zh', 'en')).toBe(buildBuiltinCatalog('zh', 'en'));
    expect(buildBuiltinCatalog('en')).not.toBe(buildBuiltinCatalog('zh', 'en'));
  });

  test('active→fallback→key, keeps raw {{…}} / plural-suffix keys', () => {
    const cat = buildCatalog('zh', [en, zh]);
    expect(cat['cmd.new.started']).toBe('🆕 已开始新的对话。'); // zh override
    expect(cat['cmd.compact.done']).toBe(enMessages['cmd.compact.done'] ?? ''); // fallback to en
    expect(cat['cmd.reset.done_other']).toBe('🧹 已清除 {{count}} 条消息。'); // raw template
  });

  test('buildCatalogOverlay keeps only runtime overrides and extension keys', () => {
    const overlay = buildCatalogOverlay('en', {
      'cmd.new.started': builtinEnMessages['cmd.new.started'] ?? '',
      'web.custom.atom': 'Custom {{name}}'
    });
    expect(overlay).toEqual({ 'web.custom.atom': 'Custom {{name}}' });
  });
});
