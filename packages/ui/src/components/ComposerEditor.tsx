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

import { renderComposerInlineChip } from './ComposerInlineChip';
import { mentionToken, parseMentionTokens } from './MentionText';

export { renderComposerInlineChip } from './ComposerInlineChip';

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

export type ComposerCommandToken = {
  label: string;
  raw: string;
};

export type ComposerSendShortcut = 'enter' | 'mod-enter-for-multiline' | 'mod-enter-always';
export const LONG_PROMPT_CHARACTER_THRESHOLD = 160;

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
const COMPOSER_EDITOR_INPUT_CLASS =
  'composer-editor-input composer-tiptap-input min-w-0 flex-1 overflow-y-auto p-1 text-[15px] leading-[22px] outline-none whitespace-pre-wrap break-words [overflow-wrap:anywhere]';
export const COMPOSER_EDITOR_IMMEDIATELY_RENDER = true;

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
    return renderComposerInlineChip({
      attributes: mergeAttributes(options.HTMLAttributes, {
        'data-mention-id': node.attrs.id,
        'data-mention-name': name
      }),
      kind: 'mention',
      label: name
    });
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
    return renderComposerInlineChip({
      attributes: {
        'data-skill-token-id': HTMLAttributes.id,
        'data-skill-token-raw': HTMLAttributes.raw,
        title: HTMLAttributes.label
      },
      icon: String(HTMLAttributes.icon ?? ''),
      kind: 'skill',
      label: String(HTMLAttributes.label ?? '')
    });
  },

  renderText({ node }) {
    return String(node.attrs.raw ?? '');
  }
});

const CommandTokenNode = Node.create({
  name: 'composerCommandToken',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      label: { default: '' },
      raw: { default: '' }
    };
  },

  renderHTML({ HTMLAttributes }) {
    return renderComposerInlineChip({
      attributes: {
        'data-command-token-raw': HTMLAttributes.raw,
        title: HTMLAttributes.label
      },
      kind: 'command',
      label: String(HTMLAttributes.label ?? '')
    });
  },

  renderText({ node }) {
    return String(node.attrs.raw ?? '');
  }
});

const HardBreakNode = Node.create({
  name: 'hardBreak',
  group: 'inline',
  inline: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'br' }];
  },

  renderHTML() {
    return ['br'];
  }
});

export const ComposerEditor = forwardRef(function ComposerEditor(
  {
    ariaLabel,
    commandToken,
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
    commandToken?: ComposerCommandToken;
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
  const commandTokenRef = useRef(commandToken);
  const onFilesRef = useRef(onFiles);
  const onKeyDownRef = useRef(onKeyDown);
  const onPasteTextRef = useRef(onPasteText);
  const skillTokenRef = useRef(skillToken);
  const valueRef = useRef(value);
  commandTokenRef.current = commandToken;
  onFilesRef.current = onFiles;
  onKeyDownRef.current = onKeyDown;
  onPasteTextRef.current = onPasteText;
  skillTokenRef.current = skillToken;
  const activePlaceholder = placeholder && value.trim().length === 0 ? placeholder : '';
  const editorAttributes = useMemo(
    () => ({
      'aria-label': ariaLabel,
      'aria-multiline': 'true',
      'data-placeholder': activePlaceholder,
      class: COMPOSER_EDITOR_INPUT_CLASS
    }),
    [activePlaceholder, ariaLabel]
  );

  const extensions = useMemo(
    () => [Document, Paragraph, Text, HardBreakNode, ChatMentionExtension, SkillTokenNode, CommandTokenNode],
    []
  );
  const editor = useEditor({
    extensions,
    content: serializedTextToTiptapDoc(value, skillToken, commandToken),
    editable: !disabled,
    immediatelyRender: COMPOSER_EDITOR_IMMEDIATELY_RENDER,
    editorProps: {
      attributes: editorAttributes,
      handleClick(_view, _pos, event) {
        const target = event.target instanceof Element ? event.target : null;
        const deleteTarget = target?.closest<HTMLElement>('[data-composer-token-delete]');
        if (deleteTarget && editor) {
          const token = deleteTarget.closest<HTMLElement>('[data-skill-token-raw], [data-command-token-raw]');
          if (token && deleteComposerToken(editor, token)) {
            event.preventDefault();
            return true;
          }
        }
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
        const currentText = editor ? tiptapDocToSerializedText(editor.getJSON()) : '';
        const action = composerEnterAction(
          {
            characterCount: currentText.length,
            hasMultipleLines: currentText.includes('\n'),
            key: event.key,
            primaryModifier: primaryModifierPressed(event),
            shiftKey: event.shiftKey
          },
          sendShortcut
        );
        if (action === 'submit') {
          event.preventDefault();
          onSubmit();
          return true;
        }
        if (action === 'line-break') {
          event.preventDefault();
          editor?.chain().focus().insertContent({ type: 'hardBreak' }).scrollIntoView().run();
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
        editor.commands.setContent(serializedTextToTiptapDoc('', skillTokenRef.current, commandTokenRef.current), {
          emitUpdate: false
        });
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
    editor.commands.setContent(serializedTextToTiptapDoc(value, skillToken, commandToken), { emitUpdate: false });
    activeMentionRef.current = null;
    onMentionChange?.(null, null);
  }, [commandToken, editor, onMentionChange, skillToken, value]);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: editorAttributes
      }
    });
  }, [editor, editorAttributes]);

  useEffect(() => {
    if (!editorRef) return;
    const node = editorDom(editor);
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
      `}</style>
      <EditorContent
        className="composer-tiptap-editor min-w-0 flex-1"
        editor={editor}
        onKeyUp={onKeyUp}
      />
    </div>
  );
});

function editorDom(editor: Editor | null): HTMLDivElement | null {
  if (!editor || editor.isDestroyed) return null;
  try {
    return editor.view.dom as HTMLDivElement;
  } catch {
    return null;
  }
}

type ComposerKeyIntent = {
  characterCount?: number;
  hasMultipleLines?: boolean;
  key: string;
  primaryModifier: boolean;
  shiftKey: boolean;
};

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

export function composerEnterAction(
  intent: ComposerKeyIntent,
  shortcut: ComposerSendShortcut
): 'ignore' | 'line-break' | 'submit' {
  if (intent.key !== 'Enter') return 'ignore';
  return shouldSubmitComposerKey(intent, shortcut) ? 'submit' : 'line-break';
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

function deleteComposerToken(editor: Editor, element: HTMLElement): boolean {
  const position = editor.view.posAtDOM(element, 0);
  for (const pos of [position, position - 1]) {
    if (pos < 0) continue;
    const node = editor.state.doc.nodeAt(pos);
    if (node?.type.name !== 'composerSkillToken' && node?.type.name !== 'composerCommandToken') continue;
    editor
      .chain()
      .focus()
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .run();
    return true;
  }
  return false;
}

function serializedTextToTiptapDoc(
  text: string,
  skillToken?: ComposerSkillToken,
  commandToken?: ComposerCommandToken
): JSONContent {
  const paragraphs = text.split('\n');
  return {
    type: 'doc',
    content: paragraphs.map((paragraph) => ({
      type: 'paragraph',
      content: serializedLineToContent(paragraph, skillToken, commandToken)
    }))
  };
}

function serializedLineToContent(
  text: string,
  skillToken?: ComposerSkillToken,
  commandToken?: ComposerCommandToken
): JSONContent[] {
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
    })),
    ...parseCommandTokens(text, commandToken).map((token) => ({
      kind: 'command' as const,
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
    } else if (span.kind === 'skill') {
      content.push({ type: 'composerSkillToken', attrs: span.token.payload });
    } else {
      content.push({ type: 'composerCommandToken', attrs: span.token.payload });
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

function parseCommandTokens(
  text: string,
  commandToken?: ComposerCommandToken
): { end: number; payload: ComposerCommandToken; start: number }[] {
  if (!commandToken?.raw) return [];
  const leading = /^\s*/.exec(text)?.[0].length ?? 0;
  if (!text.startsWith(commandToken.raw, leading)) return [];
  const end = leading + commandToken.raw.length;
  const next = text[end];
  if (next && !/\s/.test(next)) return [];
  return [{ start: leading, end, payload: commandToken }];
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
  if (node.type === 'composerCommandToken') return String(node.attrs?.raw ?? '');
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(tiptapNodeToSerializedText).join('');
}
