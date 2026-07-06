'use client';

import type { JSONContent } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import type { ForwardedRef, MutableRefObject, ReactElement } from 'react';

import { mergeAttributes, Node } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { EditorContent, useEditor } from '@tiptap/react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';

import { mentionToken, parseMentionTokens } from './MentionText';

export type ComposerMentionTarget = { id: string; name: string };

export type ComposerMentionState = {
  query: string;
  start: number;
};

export type ComposerMentionPosition = {
  bottom: number;
  left: number;
};

export type ComposerSkillToken = {
  icon?: string;
  id: string;
  label: string;
  onClick?: () => void;
  raw: string;
  source?: string;
  version?: string;
};

export type ComposerSendShortcut = 'enter' | 'mod-enter-for-multiline' | 'mod-enter-always';

export type ComposerEditorHandle = {
  appendText: (text: string) => void;
  clear: () => void;
  focus: () => void;
  insertMention: (target: ComposerMentionTarget) => void;
};

type ActiveMentionRange = ComposerMentionState & {
  from: number;
  to: number;
};

const SKILL_ID_RE =
  /\/((?:global:[a-z0-9-]+)|(?:atom-pack:[a-z0-9-]+:[a-z0-9-]+)|(?:agent:[a-z0-9-]+:[a-z0-9-]+))(?=\s|$)/g;
const HUGEICONS_SYMBOL_NAME_RE = /^[A-Z][A-Za-z0-9]*Icon$/;

function renderableIconText(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  const value = icon.trim();
  if (!value || HUGEICONS_SYMBOL_NAME_RE.test(value)) return undefined;
  return value;
}

function fallbackSkillLabel(id: string): string {
  const parts = id.split(':');
  if (parts.length === 2 && parts[0] === 'global') return parts[1] ?? id;
  if (parts.length === 3 && (parts[0] === 'atom-pack' || parts[0] === 'agent')) return parts[2] ?? id;
  return id;
}

function fallbackSkillSource(id: string): string | undefined {
  const parts = id.split(':');
  if (parts.length === 2 && parts[0] === 'global') return 'Global';
  if (parts.length === 3 && parts[0] === 'atom-pack') return `Atom Pack: ${parts[1]}`;
  if (parts.length === 3 && parts[0] === 'agent') return `Agent: ${parts[1]}`;
  return undefined;
}

const ChatMentionExtension = Mention.configure({
  renderHTML({ node, options }) {
    const name = String(node.attrs.label ?? node.attrs.id ?? '');
    return [
      'span',
      mergeAttributes(options.HTMLAttributes, {
        'data-mention-id': node.attrs.id,
        'data-mention-name': name,
        class: 'inline-flex items-baseline gap-[0.14em] align-baseline text-[0.92em] text-accent-blue leading-[inherit]'
      }),
      [
        'span',
        {
          'aria-hidden': 'true',
          class: 'inline-block size-[0.94em] shrink-0 translate-y-[0.14em] bg-current',
          style:
            'mask-image: url("/monad-icon-vector-solid.svg"); -webkit-mask-image: url("/monad-icon-vector-solid.svg"); mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat; mask-position: center; -webkit-mask-position: center; mask-size: contain; -webkit-mask-size: contain;'
        }
      ],
      name
    ];
  },

  renderText({ node }) {
    return mentionToken({ id: String(node.attrs.id ?? ''), name: String(node.attrs.label ?? '') });
  }
});

const SkillTokenNode = Node.create({
  name: 'composerSkillToken',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      icon: { default: '' },
      id: { default: '' },
      label: { default: '' },
      raw: { default: '' },
      source: { default: '' },
      version: { default: '' }
    };
  },

  renderHTML({ HTMLAttributes }) {
    const icon = String(HTMLAttributes.icon ?? '');
    const iconText = renderableIconText(icon);
    const iconNode =
      icon.startsWith('http://') || icon.startsWith('https://')
        ? [
            'span',
            {
              class: 'size-4 shrink-0 rounded bg-center bg-cover',
              style: `background-image: url("${icon.replaceAll('"', '\\"')}")`
            }
          ]
        : iconText
          ? ['span', { class: 'grid size-4 shrink-0 place-items-center text-xs' }, iconText]
          : [
              'span',
              {
                class: 'grid size-4 shrink-0 place-items-center text-xs',
                'data-skill-token-default-icon': 'true'
              },
              '□'
            ];

    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-skill-token-raw': HTMLAttributes.raw,
        class:
          'mx-0.5 inline-flex max-w-full translate-y-[2px] items-center gap-1.5 rounded-(--radius-md) border border-primary/20 bg-background px-2 py-0.5 text-left text-accent-foreground text-sm shadow-xs transition hover:border-primary/35 hover:bg-accent/70'
      }),
      iconNode,
      ['span', { class: 'truncate font-medium' }, HTMLAttributes.label],
      HTMLAttributes.source
        ? [
            'span',
            {
              class:
                'shrink-0 rounded-(--radius-xs) border border-current/15 bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground'
            },
            HTMLAttributes.source
          ]
        : '',
      HTMLAttributes.version
        ? [
            'span',
            {
              class:
                'shrink-0 rounded-(--radius-xs) border border-current/15 px-1.5 py-0.5 text-[10px] text-muted-foreground'
            },
            `v${HTMLAttributes.version}`
          ]
        : ''
    ];
  },

  renderText({ node }) {
    return String(node.attrs.raw ?? '');
  }
});

export const ComposerEditor = forwardRef(function ComposerEditor(
  {
    ariaLabel,
    disabled,
    editorRef,
    mention,
    onBlur,
    onChange,
    onFiles,
    onKeyDown,
    onKeyUp,
    onMentionChange,
    onPasteText,
    onSubmit,
    placeholder,
    sendShortcut = 'enter',
    skillToken,
    value
  }: {
    ariaLabel: string;
    disabled: boolean;
    editorRef?: React.Ref<HTMLDivElement>;
    mention?: boolean;
    onBlur?: React.FocusEventHandler<HTMLElement>;
    onChange: (value: string) => void;
    onFiles?: (files: File[]) => void;
    onKeyDown?: (event: KeyboardEvent) => boolean;
    onKeyUp?: React.KeyboardEventHandler<HTMLElement>;
    onMentionChange?: (mention: ComposerMentionState | null, position: ComposerMentionPosition | null) => void;
    onPasteText?: (text: string) => boolean;
    onSubmit: () => void;
    placeholder?: string;
    sendShortcut?: ComposerSendShortcut;
    skillToken?: ComposerSkillToken;
    value: string;
  },
  ref: ForwardedRef<ComposerEditorHandle>
): ReactElement {
  const activeMentionRef = useRef<ActiveMentionRange | null>(null);
  const onFilesRef = useRef(onFiles);
  const onKeyDownRef = useRef(onKeyDown);
  const onPasteTextRef = useRef(onPasteText);
  const skillTokenRef = useRef(skillToken);
  const valueRef = useRef(value);
  onFilesRef.current = onFiles;
  onKeyDownRef.current = onKeyDown;
  onPasteTextRef.current = onPasteText;
  skillTokenRef.current = skillToken;

  const extensions = useMemo(() => [Document, Paragraph, Text, ChatMentionExtension, SkillTokenNode], []);
  const editor = useEditor({
    extensions,
    content: serializedTextToTiptapDoc(value, skillToken),
    editable: !disabled,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        class:
          'composer-editor-input composer-tiptap-input min-w-0 flex-1 overflow-y-auto p-1 text-[15px] leading-[22px] outline-none whitespace-pre-wrap break-words [overflow-wrap:anywhere]'
      },
      handleClick(_view, _pos, event) {
        const target = event.target instanceof Element ? event.target : null;
        const skill = target?.closest<HTMLElement>('[data-skill-token-raw]');
        const raw = skill?.dataset.skillTokenRaw;
        if (!raw || skillTokenRef.current?.raw !== raw) return false;
        event.preventDefault();
        skillTokenRef.current.onClick?.();
        return true;
      },
      handleDrop(_view, event) {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length && onFilesRef.current) {
          event.preventDefault();
          onFilesRef.current(files);
          return true;
        }
        return false;
      },
      handleKeyDown(_view, event) {
        if (onKeyDownRef.current?.(event)) return true;
        if (
          shouldSubmitComposerKey(
            {
              key: event.key,
              primaryModifier: primaryModifierPressed(event),
              shiftKey: event.shiftKey
            },
            sendShortcut
          )
        ) {
          event.preventDefault();
          onSubmit();
          return true;
        }
        return false;
      },
      handlePaste(_view, event) {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length && onFilesRef.current) {
          event.preventDefault();
          onFilesRef.current(files);
          return true;
        }
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (text && onPasteTextRef.current?.(text)) {
          event.preventDefault();
          return true;
        }
        return false;
      }
    },
    onBlur({ event }) {
      activeMentionRef.current = null;
      onMentionChange?.(null, null);
      onBlur?.(event as unknown as React.FocusEvent<HTMLElement>);
    },
    onSelectionUpdate({ editor }) {
      if (mention && onMentionChange) syncMention(editor, activeMentionRef, onMentionChange);
    },
    onUpdate({ editor }) {
      const text = tiptapDocToSerializedText(editor.getJSON());
      valueRef.current = text;
      onChange(text);
      if (mention && onMentionChange) syncMention(editor, activeMentionRef, onMentionChange);
    }
  });

  useImperativeHandle(
    ref,
    () => ({
      appendText(text: string): void {
        if (!editor) return;
        const prefix = tiptapDocToSerializedText(editor.getJSON()).trim() ? ' ' : '';
        editor.chain().focus().insertContent(`${prefix}${text}`).run();
      },
      clear(): void {
        if (!editor) return;
        valueRef.current = '';
        editor.commands.setContent(serializedTextToTiptapDoc('', skillTokenRef.current), { emitUpdate: false });
        activeMentionRef.current = null;
        onMentionChange?.(null, null);
      },
      focus(): void {
        editor?.commands.focus('end');
      },
      insertMention(target: ComposerMentionTarget): void {
        if (!editor || !activeMentionRef.current) return;
        const { from, to } = activeMentionRef.current;
        editor
          .chain()
          .focus()
          .deleteRange({ from, to })
          .insertContent([
            { type: 'mention', attrs: { id: target.id, label: target.name } },
            { type: 'text', text: ' ' }
          ])
          .run();
        activeMentionRef.current = null;
        onMentionChange?.(null, null);
      }
    }),
    [editor, onMentionChange]
  );

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor || valueRef.current === value) return;
    valueRef.current = value;
    editor.commands.setContent(serializedTextToTiptapDoc(value, skillToken), { emitUpdate: false });
    activeMentionRef.current = null;
    onMentionChange?.(null, null);
  }, [editor, onMentionChange, skillToken, value]);

  useEffect(() => {
    if (!editorRef) return;
    const node = (editor?.view.dom ?? null) as HTMLDivElement | null;
    if (typeof editorRef === 'function') {
      editorRef(node);
      return () => {
        editorRef(null);
      };
    }
    (editorRef as MutableRefObject<HTMLDivElement | null>).current = node;
    return () => {
      (editorRef as MutableRefObject<HTMLDivElement | null>).current = null;
    };
  }, [editor, editorRef]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <style>{`
        .composer-tiptap-editor {
          display: flex;
          min-height: 0;
          overflow: hidden;
        }
        .composer-tiptap-editor .ProseMirror {
          max-height: 100%;
        }
        .composer-tiptap-editor .ProseMirror p {
          margin: 0;
        }
        .composer-skill-default-icon svg {
          display: block;
        }
      `}</style>
      <EditorContent
        className="composer-tiptap-editor min-w-0 flex-1"
        editor={editor}
        onKeyUp={onKeyUp}
      />
      {placeholder && value.trim().length === 0 ? (
        <div className="composer-editor-placeholder pointer-events-none">{placeholder}</div>
      ) : null}
    </div>
  );
});

type ComposerKeyIntent = {
  key: string;
  primaryModifier: boolean;
  shiftKey: boolean;
};

export function shouldSubmitComposerKey(intent: ComposerKeyIntent, shortcut: ComposerSendShortcut): boolean {
  if (intent.key !== 'Enter') return false;
  if (intent.shiftKey) return false;
  if (shortcut === 'enter') return !intent.primaryModifier;
  if (shortcut === 'mod-enter-for-multiline') return !intent.primaryModifier;
  return intent.primaryModifier;
}

function primaryModifierPressed(event: KeyboardEvent): boolean {
  if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)) return event.metaKey;
  return event.ctrlKey;
}

function syncMention(
  editor: Editor,
  activeMentionRef: React.MutableRefObject<ActiveMentionRange | null>,
  onMentionChange: (mention: ComposerMentionState | null, position: ComposerMentionPosition | null) => void
): void {
  const { from } = editor.state.selection;
  const before = editor.state.doc.textBetween(0, from, '\n', '\n');
  const mention = activeMention(before, before.length);
  if (!mention) {
    activeMentionRef.current = null;
    onMentionChange(null, null);
    return;
  }
  const range = {
    ...mention,
    from: from - mention.query.length - 1,
    to: from
  };
  activeMentionRef.current = range;
  onMentionChange(mention, mentionPosition(editor, range.from));
}

function activeMention(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const match = before.match(/(?:^|\s)@([\w.-]*)$/);
  if (!match) return null;
  const query = match[1] ?? '';
  return { query, start: caret - query.length - 1 };
}

function mentionPosition(editor: Editor, from: number): ComposerMentionPosition | null {
  const frame = editor.view.dom.closest<HTMLElement>('.chat-input-frame');
  if (!frame) return null;
  const coords = editor.view.coordsAtPos(from);
  const frameRect = frame.getBoundingClientRect();
  return {
    bottom: Math.max(8, frameRect.bottom - coords.top + 6),
    left: Math.max(8, Math.min(coords.left - frameRect.left - 2, frameRect.width - 188))
  };
}

function serializedTextToTiptapDoc(text: string, skillToken?: ComposerSkillToken): JSONContent {
  const paragraphs = text.split('\n');
  return {
    type: 'doc',
    content: paragraphs.map((paragraph) => ({
      type: 'paragraph',
      content: serializedLineToContent(paragraph, skillToken)
    }))
  };
}

function serializedLineToContent(text: string, skillToken?: ComposerSkillToken): JSONContent[] {
  const content: JSONContent[] = [];
  let cursor = 0;
  const spans = [
    ...parseMentionTokens(text).map((token) => ({
      kind: 'mention' as const,
      start: token.start,
      end: token.end,
      token
    })),
    ...parseSkillTokens(text, skillToken).map((token) => ({
      kind: 'skill' as const,
      start: token.start,
      end: token.end,
      token
    }))
  ].sort((a, b) => a.start - b.start);

  for (const span of spans) {
    if (span.start < cursor) continue;
    if (span.start > cursor) content.push({ type: 'text', text: text.slice(cursor, span.start) });
    if (span.kind === 'mention') {
      content.push({ type: 'mention', attrs: { id: span.token.id, label: span.token.name } });
    } else {
      content.push({ type: 'composerSkillToken', attrs: span.token.payload });
    }
    cursor = span.end;
  }
  if (cursor < text.length) content.push({ type: 'text', text: text.slice(cursor) });
  return content;
}

function parseSkillTokens(
  text: string,
  skillToken?: ComposerSkillToken
): { end: number; payload: ComposerSkillToken; start: number }[] {
  return [...text.matchAll(SKILL_ID_RE)].map((match) => {
    const start = match.index ?? 0;
    const id = match[1] as string;
    const raw = `/${id}`;
    return {
      start,
      end: start + raw.length,
      payload:
        skillToken?.raw === raw
          ? skillToken
          : {
              id,
              label: fallbackSkillLabel(id),
              raw,
              source: fallbackSkillSource(id)
            }
    };
  });
}

function tiptapDocToSerializedText(doc: JSONContent): string {
  return (doc.content ?? []).map(tiptapBlockToSerializedText).join('\n');
}

function tiptapBlockToSerializedText(block: JSONContent): string {
  return (block.content ?? []).map(tiptapNodeToSerializedText).join('');
}

function tiptapNodeToSerializedText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'mention') {
    return mentionToken({ id: String(node.attrs?.id ?? ''), name: String(node.attrs?.label ?? '') });
  }
  if (node.type === 'composerSkillToken') return String(node.attrs?.raw ?? '');
  return (node.content ?? []).map(tiptapNodeToSerializedText).join('');
}
