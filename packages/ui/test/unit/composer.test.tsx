import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import * as ComposerModule from '../../src/components/Composer';
import { UnifiedComposer } from '../../src/components/Composer';
import {
  ComposerEditor,
  composerEnterAction,
  LONG_PROMPT_CHARACTER_THRESHOLD,
  renderComposerInlineChip,
  shouldSubmitComposerKey
} from '../../src/components/ComposerEditor';

test('UnifiedComposer renders composed controls without React key warnings', () => {
  const errors: unknown[][] = [];
  const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });

  try {
    renderToStaticMarkup(
      <UnifiedComposer
        controls={{
          access: <button type="button">Access</button>,
          context: <button type="button">Context</button>,
          model: <button type="button">Model</button>,
          submit: <button type="button">Submit</button>,
          voice: <button type="button">Voice</button>
        }}
        editor={<textarea aria-label="Message" />}
      />
    );
  } finally {
    errorSpy.mockRestore();
  }

  expect(errors).toEqual([]);
});

test('UnifiedComposer renders built-in accessory controls from enumerated config', () => {
  const markup = renderToStaticMarkup(
    <UnifiedComposer
      accessoryControls={{
        access: {
          ariaLabel: 'Approval strength',
          askLabel: 'Full access',
          autoLabel: 'Auto',
          mode: 'ask'
        },
        items: ['access', 'usage', 'model'],
        model: {
          ariaLabel: 'Model',
          current: 'openai',
          currentEffort: 'medium',
          currentModel: 'gpt-5',
          profileDefault: {
            label: 'Default',
            modelLabel: 'GPT-5',
            effort: 'medium'
          },
          providers: [
            {
              label: 'OpenAI',
              models: [{ displayName: 'GPT-5', effort: 'medium', label: 'gpt-5', value: 'gpt-5' }],
              value: 'openai'
            },
            {
              label: 'Anthropic',
              models: [{ displayName: 'Claude Sonnet', effort: 'high', label: 'sonnet', value: 'sonnet' }],
              value: 'anthropic'
            }
          ]
        },
        usage: {
          ariaLabel: 'Usage',
          percent: 55,
          title: '5.5 used'
        }
      }}
      controls={{
        submit: <button type="button">Submit</button>,
        voice: <button type="button">Voice</button>
      }}
      editor={<textarea aria-label="Message" />}
    />
  );

  const labels = [...markup.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
  const buttonText = [...markup.matchAll(/<button[^>]*>(?:<[^>]+>)*([^<]+)(?:<[^>]+>)*<\/button>/g)].map(
    (match) => match[1]
  );
  const optionText = [...markup.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((match) => match[1]);
  const modelTrigger = /<button aria-label="Model"[^>]*><span>([^<]+)<\/span><\/button>/.exec(markup);
  const approvalSelect = /<select aria-label="Approval strength"[^>]*style="([^"]+)"/.exec(markup);

  expect(labels).toEqual(['Message composer', 'Message', 'Approval strength', 'Usage', 'Model']);
  expect(buttonText).toEqual(['Voice', 'Submit', 'GPT-5']);
  expect(optionText).toEqual(['Auto', 'Full access']);
  expect(modelTrigger?.slice(1)).toEqual(['GPT-5']);
  expect(approvalSelect?.[1]).toContain('field-sizing:content');
});

test('composer aurora responds only to editor focus', () => {
  const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
  const normalizedCss = css.replace(/\s+/g, ' ');
  const editorFocusSelector =
    '.chat-input-chrome:has(.chat-input-content :is(input, textarea, [contenteditable="true"]):focus)';

  expect(normalizedCss).toContain(`${editorFocusSelector} .chat-input-aurora,`);
  expect(normalizedCss).toContain(`${editorFocusSelector} .chat-input-aurora-gradient,`);
  expect(css).not.toContain('.chat-input-chrome:focus-within .chat-input-aurora');
});

test('context usage remains informative and clickable before usage data is available', () => {
  const markup = renderToStaticMarkup(
    <UnifiedComposer
      accessoryControls={{
        items: ['usage'],
        usage: {
          ariaLabel: 'Context usage',
          percent: 0,
          title: 'Context usage',
          unavailableLabel: 'Usage data is not available yet'
        }
      }}
      editor={<textarea aria-label="Message" />}
    />
  );

  expect(markup).toBe(
    '<fieldset aria-label="Message composer" style="border:0;margin:0;min-inline-size:0;padding:0"><div class="chat-input-chrome shared-composer-panel"><div class="chat-input-frame"><div class="chat-input-surface-frame"><div aria-hidden="true" class="chat-input-aurora"><div class="chat-input-aurora-root"><div class="chat-input-aurora-inner-glow"><div class="chat-input-aurora-glow-pulse"><div class="chat-input-aurora-edge-mask"><div class="chat-input-aurora-blur-field"><div class="chat-input-aurora-gradient"></div></div></div></div></div><div class="chat-input-aurora-border-pulse"><div class="chat-input-aurora-border-mask"><div class="chat-input-aurora-gradient"></div></div></div></div></div><div class="chat-input-surface composer-live-dense" role="presentation"><div class="chat-input-content" style="opacity:1"><textarea aria-label="Message"></textarea></div></div></div><div class="shared-composer-accessory-rail" style="align-items:center;display:flex;gap:8px;justify-content:space-between;min-width:0"><div class="shared-composer-accessory shared-composer-accessory-left" style="align-items:center;display:inline-flex;gap:4px;min-width:0"></div><div class="shared-composer-accessory shared-composer-accessory-right" style="align-items:center;display:inline-flex;gap:4px;margin-left:auto;min-width:0"><button data-state="closed" data-slot="popover-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Context usage" class="workplace-action" style="flex:none;width:32px;height:32px;border:none;border-radius:50%;background:transparent;color:var(--shared-composer-control-fg, var(--muted-foreground));cursor:pointer;display:flex;align-items:center;justify-content:center" title="Usage data is not available yet"><svg aria-hidden="true" height="18" viewBox="0 0 24 24" width="18"><circle cx="12" cy="12" fill="none" opacity="0.25" r="10" stroke="currentColor" stroke-width="2"></circle><circle cx="12" cy="12" fill="none" opacity="0.78" r="10" stroke="currentColor" stroke-dasharray="62.83185307179586 62.83185307179586" stroke-dashoffset="62.83185307179586" stroke-linecap="round" stroke-width="2" style="transform:rotate(-90deg);transform-origin:center"></circle></svg></button></div></div></div></div></fieldset>'
  );
});

test('composer model menu follows global item density and viewport-aware placement', () => {
  const markup = renderToStaticMarkup(
    <UnifiedComposer
      accessoryControls={{
        items: ['model'],
        model: {
          ariaLabel: 'Model',
          current: 'openai',
          currentEffort: 'medium',
          currentModel: 'gpt-5',
          profileDefault: {
            label: 'Default',
            modelLabel: 'GPT-5',
            effort: 'medium'
          },
          providers: [
            {
              label: 'OpenAI',
              models: [{ displayName: 'GPT-5', effort: 'medium', label: 'gpt-5', value: 'gpt-5' }],
              value: 'openai'
            }
          ]
        }
      }}
      editor={<textarea aria-label="Message" />}
    />
  );
  const trigger =
    /<button[^>]*aria-label="Model"[^>]*class="([^"]+)" style="([^"]+)"[^>]*><span>([^<]+)<\/span><\/button>/.exec(
      markup
    );

  expect(trigger?.slice(1)).toEqual([
    'workplace-action shared-composer-pill',
    'align-items:center;background:var(--shared-composer-control-bg, transparent);border:none;border-radius:999px;color:var(--shared-composer-control-fg, var(--muted-foreground));cursor:pointer;display:inline-flex;flex:none;font-family:var(--font-sans), ui-sans-serif, system-ui, sans-serif;font-size:var(--shared-composer-font-size, 13px);font-weight:var(--shared-composer-font-weight, 500);gap:4px;min-height:32px;padding:0 var(--shared-composer-pill-x, 7px);white-space:nowrap',
    'GPT-5'
  ]);
  expect(markup).not.toContain('<span style="color:var(--muted-foreground);font-weight:400">Medium</span>');
});

test('composer renders effort as a separate accessory control', () => {
  const markup = renderToStaticMarkup(
    <UnifiedComposer
      accessoryControls={{
        effort: {
          ariaLabel: 'Effort',
          current: 'medium',
          control: <div>Effort slider</div>,
          onOpenChange: () => {}
        },
        items: ['model', 'effort'],
        model: {
          currentModel: 'openai:gpt-5',
          currentProvider: 'openai',
          providers: [
            {
              label: 'OpenAI',
              models: [
                {
                  displayName: 'GPT-5',
                  efforts: ['low', 'medium', 'high'],
                  label: 'gpt-5',
                  value: 'openai:gpt-5'
                }
              ],
              value: 'openai'
            }
          ]
        }
      }}
      editor={<textarea aria-label="Message" />}
    />
  );

  expect(markup).toContain('aria-label="Model"');
  expect(markup).toContain('aria-label="Effort"');
  expect(markup).toContain('>Medium</button>');
});

test('composer model menu opens toward right-side space with content-sized cascading levels', () => {
  const layout = ComposerModule.composerModelMenuLayout();

  expect(layout).toEqual({
    align: 'start',
    collisionPadding: 12,
    itemClassName: 'cursor-pointer',
    modelListClassName: 'h-72 overflow-y-auto',
    modelNameClassName: 'max-w-72 truncate pl-3',
    rootContentClassName: 'w-max min-w-[180px] max-w-[var(--radix-dropdown-menu-content-available-width)]',
    searchContainerClassName: 'w-full pb-2',
    searchInputClassName: 'h-8 w-full rounded-sm border bg-background px-2 text-sm outline-none',
    side: 'top',
    sticky: 'partial',
    subContentClassName:
      'w-max min-w-[160px] max-w-[var(--radix-dropdown-menu-content-available-width)] overflow-hidden',
    valueClassName: 'ml-auto max-w-56 truncate text-right text-muted-foreground'
  });
});

test('composer model menu dimensions depend on the complete provider catalog', () => {
  const panelWidth = (
    ComposerModule as typeof ComposerModule & {
      composerModelMenuPanelWidth?: (provider: {
        label: string;
        models: Array<{ displayName?: string; label: string; value: string }>;
        value: string;
      }) => number;
    }
  ).composerModelMenuPanelWidth;
  const provider = {
    label: 'OpenRouter',
    models: [
      { displayName: 'GPT-5', label: 'gpt-5', value: 'gpt-5' },
      {
        displayName: 'Google: Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)',
        label: 'google-image',
        value: 'google-image'
      }
    ],
    value: 'openrouter'
  };

  expect(panelWidth?.(provider)).toBe(352);
  expect(panelWidth?.({ ...provider, models: provider.models.slice(0, 1) })).toBe(256);
});

test('composer model menu groups models under configured providers', () => {
  const sections = (
    ComposerModule as typeof ComposerModule & {
      buildComposerModelMenuSections?: (model: {
        currentModel?: string;
        currentProvider?: string;
        providers: Array<{
          label: string;
          models: Array<{ displayName?: string; label: string; value: string }>;
          value: string;
        }>;
      }) => unknown;
    }
  ).buildComposerModelMenuSections?.({
    currentModel: 'gpt-5',
    currentProvider: 'openai',
    providers: [
      {
        label: 'OpenAI',
        models: [
          { displayName: 'GPT-5', label: 'gpt-5', value: 'gpt-5' },
          { label: 'gpt-4.1', value: 'gpt-4.1' }
        ],
        value: 'openai'
      },
      {
        label: 'Anthropic',
        models: [{ displayName: 'Claude Sonnet', label: 'sonnet', value: 'sonnet' }],
        value: 'anthropic'
      }
    ]
  });

  expect(sections).toEqual([
    {
      label: 'OpenAI',
      models: [
        { label: 'GPT-5', selected: true, value: 'gpt-5' },
        { label: 'gpt-4.1', selected: false, value: 'gpt-4.1' }
      ],
      selected: true,
      value: 'openai'
    },
    {
      label: 'Anthropic',
      models: [{ label: 'Claude Sonnet', selected: false, value: 'sonnet' }],
      selected: false,
      value: 'anthropic'
    }
  ]);
});

test('composer model menu hover state keeps only the active provider open', () => {
  const hoverState = (
    ComposerModule as typeof ComposerModule & {
      composerModelMenuHoverState?: (target: { kind: 'profile' | 'provider'; provider?: string }) => {
        openProvider?: string;
      };
    }
  ).composerModelMenuHoverState;

  expect(hoverState?.({ kind: 'provider', provider: 'openai' })).toEqual({ openProvider: 'openai' });
  expect(hoverState?.({ kind: 'profile' })).toEqual({ openProvider: undefined });
});

test('ComposerEditor renders placeholder through the ProseMirror input box', () => {
  const markup = renderToStaticMarkup(
    <ComposerEditor
      ariaLabel="Message"
      disabled={false}
      onChange={() => {}}
      onSubmit={() => {}}
      placeholder="Ask anything"
      value=""
    />
  );

  expect(markup).toBe(`<div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"><style>
        .composer-tiptap-editor {
          display: flex;
          min-height: 0;
          overflow: hidden;
        }
        .composer-tiptap-editor .ProseMirror {
          position: relative;
          max-height: 100%;
        }
        .composer-tiptap-editor .ProseMirror::before {
          content: attr(data-placeholder);
          float: left;
          height: 0;
          color: color-mix(in srgb, var(--chat-input-placeholder) 44%, transparent);
          pointer-events: none;
          user-select: none;
          white-space: nowrap;
        }
        .composer-tiptap-editor .ProseMirror:not([data-placeholder])::before,
        .composer-tiptap-editor .ProseMirror[data-placeholder=""]::before {
          content: none;
        }
        .composer-tiptap-editor .ProseMirror p {
          margin: 0;
        }
        .composer-skill-default-icon svg {
          display: block;
        }
      </style><div class="composer-tiptap-editor min-w-0 flex-1"></div></div>`);
});

test('ComposerEditor chip specs keep mention, skill, and command chips visually identical', () => {
  const mention = renderComposerInlineChip({ kind: 'mention', label: 'Planner' });
  const skill = renderComposerInlineChip({ icon: '⚙', kind: 'skill', label: 'Deploy' });
  const command = renderComposerInlineChip({ kind: 'command', label: 'Reset' });

  expect(mention[2]).toHaveLength(2);
  expect(skill[1]).toEqual({
    class: mention[1].class,
    'data-composer-chip': 'skill'
  });
  expect(command[1]).toEqual({
    class: mention[1].class,
    'data-composer-chip': 'command'
  });
  expect(skill[2]).toEqual([
    'span',
    {
      'aria-hidden': 'true',
      class:
        'inline-flex size-[0.94em] shrink-0 translate-y-[0.14em] items-center justify-center text-[0.94em] leading-none',
      'data-composer-chip-icon': 'skill'
    },
    '⚙'
  ]);
  expect(command[2][0]).toBe('span');
  expect(command[2][1]).toEqual({
    'aria-hidden': 'true',
    class:
      'inline-flex size-[0.94em] shrink-0 translate-y-[0.14em] items-center justify-center text-[0.94em] leading-none bg-current',
    'data-composer-chip-icon': 'command',
    style: command[2][1].style
  });
  expect(command[2].length).toBe(2);
  expect(skill).toEqual(['span', skill[1], skill[2], 'Deploy']);
  expect(command).toEqual(['span', command[1], command[2], 'Reset']);
});

test('ComposerEditor skill and command chip icons match command menu fallbacks', () => {
  const skill = renderComposerInlineChip({ kind: 'skill', label: 'Deploy' });
  const command = renderComposerInlineChip({ kind: 'command', label: 'Reset' });
  const remoteSkill = renderComposerInlineChip({
    icon: 'https://example.com/icon.png',
    kind: 'skill',
    label: 'Remote'
  });

  expect(skill[2][0]).toBe('span');
  expect(skill[2][1]).toEqual({
    'aria-hidden': 'true',
    class:
      'inline-flex size-[0.94em] shrink-0 translate-y-[0.14em] items-center justify-center text-[0.94em] leading-none bg-current',
    'data-composer-chip-icon': 'skill',
    style: skill[2][1].style
  });
  expect(command[2][0]).toBe('span');
  expect(command[2][1]).toEqual({
    'aria-hidden': 'true',
    class:
      'inline-flex size-[0.94em] shrink-0 translate-y-[0.14em] items-center justify-center text-[0.94em] leading-none bg-current',
    'data-composer-chip-icon': 'command',
    style: command[2][1].style
  });
  expect(skill[2][1].style).toBe(
    'mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M12%2022C11.1818%2022%2010.4002%2021.6698%208.83693%2021.0095C4.94564%2019.3657%203%2018.5438%203%2017.1613C3%2016.7742%203%2010.0645%203%207M12%2022C12.8182%2022%2013.5998%2021.6698%2015.1631%2021.0095C19.0544%2019.3657%2021%2018.5438%2021%2017.1613V7M12%2022L12%2011.3548%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3Cpath%20d%3D%22M8.32592%209.69138L5.40472%208.27785C3.80157%207.5021%203%207.11423%203%206.5C3%205.88577%203.80157%205.4979%205.40472%204.72215L8.32592%203.30862C10.1288%202.43621%2011.0303%202%2012%202C12.9697%202%2013.8712%202.4362%2015.6741%203.30862L18.5953%204.72215C20.1984%205.4979%2021%205.88577%2021%206.5C21%207.11423%2020.1984%207.5021%2018.5953%208.27785L15.6741%209.69138C13.8712%2010.5638%2012.9697%2011%2012%2011C11.0303%2011%2010.1288%2010.5638%208.32592%209.69138Z%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3Cpath%20d%3D%22M6%2012L8%2013%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3Cpath%20d%3D%22M17%204L7%209%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3C%2Fsvg%3E"); -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M12%2022C11.1818%2022%2010.4002%2021.6698%208.83693%2021.0095C4.94564%2019.3657%203%2018.5438%203%2017.1613C3%2016.7742%203%2010.0645%203%207M12%2022C12.8182%2022%2013.5998%2021.6698%2015.1631%2021.0095C19.0544%2019.3657%2021%2018.5438%2021%2017.1613V7M12%2022L12%2011.3548%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3Cpath%20d%3D%22M8.32592%209.69138L5.40472%208.27785C3.80157%207.5021%203%207.11423%203%206.5C3%205.88577%203.80157%205.4979%205.40472%204.72215L8.32592%203.30862C10.1288%202.43621%2011.0303%202%2012%202C12.9697%202%2013.8712%202.4362%2015.6741%203.30862L18.5953%204.72215C20.1984%205.4979%2021%205.88577%2021%206.5C21%207.11423%2020.1984%207.5021%2018.5953%208.27785L15.6741%209.69138C13.8712%2010.5638%2012.9697%2011%2012%2011C11.0303%2011%2010.1288%2010.5638%208.32592%209.69138Z%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3Cpath%20d%3D%22M6%2012L8%2013%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3Cpath%20d%3D%22M17%204L7%209%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3C%2Fsvg%3E"); mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; mask-position: center; -webkit-mask-position: center; mask-size: contain; -webkit-mask-size: contain;'
  );
  expect(command[2][1].style).toBe(
    'mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M4.00004%2017C4.00004%2017%209.99999%2012.5811%2010%2011C10%209.41884%204%205%204%205%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3Cpath%20d%3D%22M12%2019H20%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3C%2Fsvg%3E"); -webkit-mask-image: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M4.00004%2017C4.00004%2017%209.99999%2012.5811%2010%2011C10%209.41884%204%205%204%205%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3Cpath%20d%3D%22M12%2019H20%22%20stroke%3D%22black%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20%2F%3E%3C%2Fsvg%3E"); mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; mask-position: center; -webkit-mask-position: center; mask-size: contain; -webkit-mask-size: contain;'
  );
  expect(remoteSkill[2][0]).toBe('span');
  expect(remoteSkill[2][1]).toEqual({
    'aria-hidden': 'true',
    class:
      'inline-flex size-[0.94em] shrink-0 translate-y-[0.14em] items-center justify-center text-[0.94em] leading-none rounded bg-center bg-cover',
    'data-composer-chip-icon': 'skill',
    style: 'background-image: url("https://example.com/icon.png");'
  });
});

test('ComposerEditor send shortcut treats multiline and long prompts as modifier-send prompts', () => {
  expect(
    shouldSubmitComposerKey(
      {
        characterCount: LONG_PROMPT_CHARACTER_THRESHOLD - 1,
        hasMultipleLines: false,
        key: 'Enter',
        primaryModifier: false,
        shiftKey: false
      },
      'mod-enter-for-multiline'
    )
  ).toBe(true);
  expect(
    shouldSubmitComposerKey(
      {
        characterCount: LONG_PROMPT_CHARACTER_THRESHOLD,
        hasMultipleLines: false,
        key: 'Enter',
        primaryModifier: false,
        shiftKey: false
      },
      'mod-enter-for-multiline'
    )
  ).toBe(false);
  expect(
    shouldSubmitComposerKey(
      {
        characterCount: LONG_PROMPT_CHARACTER_THRESHOLD,
        hasMultipleLines: false,
        key: 'Enter',
        primaryModifier: true,
        shiftKey: false
      },
      'mod-enter-for-multiline'
    )
  ).toBe(true);
  expect(
    shouldSubmitComposerKey(
      { characterCount: 4, hasMultipleLines: true, key: 'Enter', primaryModifier: true, shiftKey: false },
      'mod-enter-for-multiline'
    )
  ).toBe(true);
});

test('ComposerEditor inserts visible line breaks whenever Enter is not the configured submit gesture', () => {
  expect(
    composerEnterAction(
      { characterCount: 4, hasMultipleLines: false, key: 'Enter', primaryModifier: false, shiftKey: true },
      'enter'
    )
  ).toBe('line-break');
  expect(
    composerEnterAction(
      {
        characterCount: LONG_PROMPT_CHARACTER_THRESHOLD,
        hasMultipleLines: false,
        key: 'Enter',
        primaryModifier: false,
        shiftKey: false
      },
      'mod-enter-for-multiline'
    )
  ).toBe('line-break');
  expect(
    composerEnterAction(
      { characterCount: 4, hasMultipleLines: false, key: 'Enter', primaryModifier: false, shiftKey: false },
      'mod-enter-always'
    )
  ).toBe('line-break');
  expect(
    composerEnterAction(
      { characterCount: 4, hasMultipleLines: false, key: 'Enter', primaryModifier: true, shiftKey: false },
      'mod-enter-always'
    )
  ).toBe('submit');
});
