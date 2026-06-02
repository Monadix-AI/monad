import type { JSONContent } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import type { ForwardedRef, ReactElement, RefObject } from 'react';
import type { ComposerCommandToken, ComposerSkillToken } from './ComposerEditorSerialization';

import { mergeAttributes, Node } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import { ListItem, OrderedList } from '@tiptap/extension-list';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { EditorContent, useEditor } from '@tiptap/react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';

import { serializedTextToTiptapDoc, tiptapDocToSerializedText } from './ComposerEditorSerialization';
import { renderComposerInlineChip } from './ComposerInlineChip';
import { mentionToken } from './MentionText';

export type { ComposerCommandToken, ComposerSkillToken } from './ComposerEditorSerialization';

export { serializedTextToTiptapDoc, tiptapDocToSerializedText } from './ComposerEditorSerialization';
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

const COMPOSER_EDITOR_INPUT_CLASS =
  'composer-editor-input composer-tiptap-input min-w-0 flex-1 overflow-y-auto p-1 text-[15px] leading-[22px] outline-none whitespace-pre-wrap break-words [overflow-wrap:anywhere]';
export const COMPOSER_EDITOR_IMMEDIATELY_RENDER = true;

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
    () => [
      Document,
      Paragraph,
      Text,
      HardBreakNode,
      OrderedList,
      ListItem,
      ChatMentionExtension,
      SkillTokenNode,
      CommandTokenNode
    ],
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
        const action = composerKeyDownAction(
          {
            inOrderedList: editor?.isActive('orderedList') ?? false,
            key: event.key,
            primaryModifier: primaryModifierPressed(event),
            shiftKey: event.shiftKey
          },
          sendShortcut,
          () => (editor ? tiptapDocToSerializedText(editor.getJSON()) : '')
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
        if (action === 'list-item') return false;
        return false;
      },
      clipboardTextSerializer(_slice, view) {
        const { from, to } = view.state.selection;
        if (from === to) return '';
        return tiptapDocToSerializedText(view.state.doc.cut(from, to).toJSON() as JSONContent);
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
    (editorRef as RefObject<HTMLDivElement | null>).current = node;
    return () => {
      (editorRef as RefObject<HTMLDivElement | null>).current = null;
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
        .composer-tiptap-editor .ProseMirror ol {
          list-style: decimal;
          margin: 0;
          padding-inline-start: 1.5rem;
        }
        .composer-tiptap-editor .ProseMirror li {
          padding-inline-start: 0.125rem;
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
  inOrderedList?: boolean;
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

export function composerKeyDownAction(
  intent: Pick<ComposerKeyIntent, 'inOrderedList' | 'key' | 'primaryModifier' | 'shiftKey'>,
  shortcut: ComposerSendShortcut,
  readCurrentText: () => string
): 'ignore' | 'line-break' | 'list-item' | 'submit' {
  if (intent.key !== 'Enter') return 'ignore';
  if (intent.inOrderedList && !intent.primaryModifier && !intent.shiftKey) return 'list-item';
  const currentText = readCurrentText();
  return composerEnterAction(
    {
      ...intent,
      characterCount: currentText.length,
      hasMultipleLines: currentText.includes('\n')
    },
    shortcut
  );
}

function primaryModifierPressed(event: KeyboardEvent): boolean {
  if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)) return event.metaKey;
  return event.ctrlKey;
}

function syncMention(
  editor: Editor,
  activeMentionRef: RefObject<ActiveMentionRange | null>,
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
