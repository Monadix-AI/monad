'use client';

import type { JSX } from 'react';

import { BoxIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  DecoratorNode,
  type EditorState,
  type LexicalEditor,
  type NodeKey,
  type SerializedLexicalNode
} from 'lexical';
import { useEffect, useMemo, useRef } from 'react';

import { renderableIconText } from '@/lib/renderable-icon-text';

export type SkillTokenPayload = {
  id: string;
  label: string;
  source?: string;
  icon?: string;
  version?: string;
  raw: string;
  onClick?: () => void;
};

type SerializedSkillTokenNode = SerializedLexicalNode & {
  payload: Omit<SkillTokenPayload, 'onClick'>;
};

const EMPTY_SKILL_TOKEN: SkillTokenPayload = {
  id: '',
  label: '',
  raw: ''
};

class SkillTokenNode extends DecoratorNode<JSX.Element> {
  __payload: SkillTokenPayload;

  static getType(): string {
    return 'skill-token';
  }

  static clone(node: SkillTokenNode): SkillTokenNode {
    return new SkillTokenNode(node.__payload, node.__key);
  }

  static importJSON(serializedNode: SerializedSkillTokenNode): SkillTokenNode {
    return new SkillTokenNode(serializedNode.payload);
  }

  constructor(payload: SkillTokenPayload = EMPTY_SKILL_TOKEN, key?: NodeKey) {
    super(key);
    this.__payload = payload;
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'inline-block';
    return span;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): true {
    return true;
  }

  isKeyboardSelectable(): false {
    return false;
  }

  getTextContent(): string {
    return this.__payload.raw;
  }

  decorate(): JSX.Element {
    return <SkillTokenChip token={this.__payload} />;
  }

  exportJSON(): SerializedSkillTokenNode {
    const { onClick: _onClick, ...payload } = this.__payload;
    return {
      ...super.exportJSON(),
      payload
    };
  }
}

function $createSkillTokenNode(payload: SkillTokenPayload): SkillTokenNode {
  return new SkillTokenNode(payload);
}

const SKILL_ID_RE =
  /\/((?:global:[a-z0-9-]+)|(?:atom-pack:[a-z0-9-]+:[a-z0-9-]+)|(?:agent:[a-z0-9-]+:[a-z0-9-]+))(?=\s|$)/g;

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

function appendParsedComposerText(text: string, skillToken?: SkillTokenPayload): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  let last = 0;
  for (const match of text.matchAll(SKILL_ID_RE)) {
    const start = match.index ?? 0;
    const id = match[1] as string;
    const raw = `/${id}`;
    if (start > last) paragraph.append($createTextNode(text.slice(last, start)));
    paragraph.append(
      $createSkillTokenNode(
        skillToken?.raw === raw
          ? skillToken
          : {
              id,
              label: fallbackSkillLabel(id),
              source: fallbackSkillSource(id),
              raw
            }
      )
    );
    last = start + raw.length;
  }
  if (last < text.length) paragraph.append($createTextNode(text.slice(last)));
  if (text.length === 0) paragraph.append($createTextNode(''));
  root.append(paragraph);
  paragraph.selectEnd();
}

function editorText(editorState: EditorState): string {
  let text = '';
  editorState.read(() => {
    text = $getRoot().getTextContent();
  });
  return text;
}

function syncEditor(editor: LexicalEditor, value: string, skillToken: SkillTokenPayload | undefined): void {
  editor.update(() => appendParsedComposerText(value, skillToken));
}

function SkillTokenChip({ token }: { token: SkillTokenPayload }): JSX.Element {
  const textIcon = renderableIconText(token.icon);
  return (
    <button
      aria-label={token.label}
      className="mx-0.5 inline-flex max-w-full translate-y-[2px] items-center gap-1.5 rounded-(--radius-md) border border-primary/20 bg-background px-2 py-0.5 text-left text-accent-foreground text-sm shadow-xs transition hover:border-primary/35 hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-ring/60"
      contentEditable={false}
      onClick={(event) => {
        event.preventDefault();
        token.onClick?.();
      }}
      type="button"
    >
      {token.icon?.startsWith('http://') || token.icon?.startsWith('https://') ? (
        <span
          className="size-4 shrink-0 rounded bg-center bg-cover"
          style={{ backgroundImage: `url(${token.icon})` }}
        />
      ) : textIcon ? (
        <span className="grid size-4 shrink-0 place-items-center text-xs">{textIcon}</span>
      ) : (
        <HugeiconsIcon
          className="size-3.5 shrink-0"
          icon={BoxIcon}
        />
      )}
      <span className="truncate font-medium">{token.label}</span>
      {token.source ? (
        <span className="shrink-0 rounded-(--radius-xs) border border-current/15 bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {token.source}
        </span>
      ) : null}
      {token.version ? (
        <span className="shrink-0 rounded-(--radius-xs) border border-current/15 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          v{token.version}
        </span>
      ) : null}
    </button>
  );
}

export function LexicalComposerInput({
  ariaLabel,
  disabled,
  editorRef,
  onBlur,
  onChange,
  onKeyDown,
  onKeyUp,
  placeholder,
  skillToken,
  value
}: {
  ariaLabel: string;
  disabled: boolean;
  editorRef?: React.Ref<HTMLDivElement>;
  onBlur?: React.FocusEventHandler<HTMLElement>;
  onChange: (value: string) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  onKeyUp?: React.KeyboardEventHandler<HTMLElement>;
  placeholder: string;
  skillToken?: SkillTokenPayload;
  value: string;
}): React.ReactElement {
  const initialValueRef = useRef(value);
  const initialSkillTokenRef = useRef(skillToken);
  const lastEditorTextRef = useRef(value);
  const skillKey = skillToken
    ? `${skillToken.raw}:${skillToken.label}:${skillToken.source ?? ''}:${skillToken.icon ?? ''}:${skillToken.version ?? ''}`
    : '';
  const initialConfig = useMemo(
    () => ({
      namespace: 'monad-composer',
      nodes: [SkillTokenNode],
      onError(error: Error) {
        throw error;
      },
      editorState(editor: LexicalEditor) {
        syncEditor(editor, initialValueRef.current, initialSkillTokenRef.current);
      },
      editable: true,
      theme: {
        paragraph: 'm-0'
      }
    }),
    []
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <ComposerInputSync
        disabled={disabled}
        skillKey={skillKey}
        skillToken={skillToken}
        value={value}
        valueRef={lastEditorTextRef}
      />
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            ariaLabel={ariaLabel}
            className="composer-lexical-input"
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            ref={editorRef}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
        placeholder={<div className="composer-lexical-placeholder">{placeholder}</div>}
      />
      <OnChangePlugin
        onChange={(editorState) => {
          const text = editorText(editorState);
          lastEditorTextRef.current = text;
          onChange(text);
        }}
      />
    </LexicalComposer>
  );
}

function ComposerInputSync({
  disabled,
  skillKey,
  skillToken,
  value,
  valueRef
}: {
  disabled: boolean;
  skillKey: string;
  skillToken?: SkillTokenPayload;
  value: string;
  valueRef: React.MutableRefObject<string>;
}): null {
  const [editor] = useLexicalComposerContext();
  const lastSkillKeyRef = useRef(skillKey);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (valueRef.current === value && lastSkillKeyRef.current === skillKey) return;
    valueRef.current = value;
    lastSkillKeyRef.current = skillKey;
    syncEditor(editor, value, skillToken);
  }, [editor, skillKey, skillToken, value, valueRef]);

  return null;
}
