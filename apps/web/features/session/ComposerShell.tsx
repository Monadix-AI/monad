'use client';

import type { JSX, ReactNode } from 'react';

import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ChatInputChrome } from '@monad/ui';
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
import { ArrowUp, Box, ChevronDown, Mic, ShieldAlert, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ 0?: { transcript?: string }; isFinal?: boolean }>;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

type ComposerShellProps = {
  access?: {
    mode: 'auto' | 'ask';
    onChange?: (mode: 'auto' | 'ask') => void;
  };
  ariaLabel: string;
  value: string;
  placeholder: string;
  busy?: boolean;
  contextUsage?: {
    approximate?: boolean;
    limit: number;
    segments?: { category: string; color?: string; label: string; tokens: number }[];
    used: number;
  };
  disabled?: boolean;
  editorSlot?: ReactNode;
  mentionMenu?: ReactNode;
  skillToken?: {
    label: string;
    source?: string;
    icon?: string;
    version?: string;
    raw: string;
    start: number;
    end: number;
    onClick: () => void;
  };
  mentionPreview?: ReactNode;
  onBlur?: React.FocusEventHandler<HTMLElement>;
  onChange?: (value: string) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  onKeyUp?: React.KeyboardEventHandler<HTMLElement>;
  onStop?: () => void;
  onSubmit: () => void;
  onVoiceText?: (text: string) => void;
  model?: {
    current?: string;
    onChange?: (model: string) => void;
    options: { label: string; value: string }[];
  };
  textareaRef?: React.Ref<HTMLDivElement>;
};

type SkillTokenPayload = {
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
      ) : token.icon ? (
        <span className="grid size-4 shrink-0 place-items-center text-xs">{token.icon}</span>
      ) : (
        <Box className="size-3.5 shrink-0" />
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

function LexicalComposerInput({
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

export function ComposerShell({
  access = { mode: 'auto' },
  ariaLabel,
  value,
  placeholder,
  busy = false,
  contextUsage,
  disabled = false,
  editorSlot,
  mentionMenu,
  skillToken,
  mentionPreview,
  onBlur,
  onChange,
  onKeyDown,
  onKeyUp,
  onStop,
  onSubmit,
  onVoiceText,
  model,
  textareaRef
}: ComposerShellProps): React.ReactElement {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const canSend = value.trim().length > 0 && !disabled;
  const canStop = busy && onStop;
  const submitDisabled = !canSend && !canStop;
  const budgetPercent = contextUsage
    ? Math.min(100, Math.round((contextUsage.used / Math.max(1, contextUsage.limit)) * 100))
    : 0;
  const voiceAvailable =
    typeof window !== 'undefined' &&
    Boolean((window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition);
  const composerSkillToken = skillToken
    ? {
        id: skillToken.raw.startsWith('/') ? skillToken.raw.slice(1) : skillToken.raw,
        label: skillToken.label,
        source: skillToken.source,
        icon: skillToken.icon,
        version: skillToken.version,
        raw: skillToken.raw,
        onClick: skillToken.onClick
      }
    : undefined;

  const toggleVoice = (): void => {
    if (!onVoiceText || !voiceAvailable) return;
    if (recognitionRef.current && listening) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }
    const SpeechRecognition =
      (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result?.isFinal) text += result[0]?.transcript ?? '';
      }
      const trimmed = text.trim();
      if (trimmed) onVoiceText(trimmed);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  };

  return (
    <ChatInputChrome className="shared-composer-panel">
      <div className="chat-input-frame">
        <div
          aria-hidden="true"
          className="chat-input-aurora"
        >
          <div className="chat-input-aurora-root">
            <div className="chat-input-aurora-inner-glow">
              <div className="chat-input-aurora-glow-pulse">
                <div className="chat-input-aurora-edge-mask">
                  <div className="chat-input-aurora-blur-field">
                    <div className="chat-input-aurora-gradient" />
                  </div>
                </div>
              </div>
            </div>
            <div className="chat-input-aurora-border-pulse">
              <div className="chat-input-aurora-border-mask">
                <div className="chat-input-aurora-gradient" />
              </div>
            </div>
          </div>
        </div>
        <div
          className="chat-input-surface composer-live-dense"
          role="presentation"
        >
          <div className="chat-input-content">
            {mentionMenu}
            {editorSlot ?? (
              <LexicalComposerInput
                ariaLabel={ariaLabel}
                disabled={disabled}
                editorRef={textareaRef}
                onBlur={onBlur}
                onChange={(nextValue) => onChange?.(nextValue)}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                placeholder={placeholder}
                skillToken={composerSkillToken}
                value={value}
              />
            )}
            {mentionPreview ? (
              <div
                className="flex flex-wrap items-center gap-1.5 px-4 pb-1.5 text-[13px]"
                style={{ color: 'var(--muted-foreground)' }}
              >
                {mentionPreview}
              </div>
            ) : null}
          </div>

          <div
            className="shared-composer-toolbar"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 5,
              padding: '0 5px 5px'
            }}
          >
            <div
              className="shared-composer-tools"
              style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
            >
              <ComposerSelect
                ariaLabel="Permission mode"
                icon={<ShieldAlert size={15} />}
                onChange={(value) => access.onChange?.(value as 'auto' | 'ask')}
                tone="ink"
                value={access.mode}
              >
                <option value="auto">Auto</option>
                <option value="ask">Ask for approval</option>
              </ComposerSelect>
            </div>

            <div
              className="shared-composer-tools shared-composer-tools-right"
              style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
            >
              <ContextUsageButton
                percent={budgetPercent}
                usage={contextUsage}
              />
              <ComposerSelect
                ariaLabel="Model"
                disabled={!model || model.options.length === 0}
                onChange={(value) => model?.onChange?.(value)}
                tone="ink"
                value={model?.current ?? model?.options[0]?.value ?? ''}
              >
                {(model?.options.length ? model.options : [{ label: 'Model', value: '' }]).map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </ComposerSelect>
              <ComposerIconButton
                active={listening}
                ariaLabel={listening ? 'Stop voice input' : voiceAvailable ? 'Voice input' : 'Voice input unavailable'}
                disabled={!onVoiceText || !voiceAvailable}
                onClick={toggleVoice}
              >
                <Mic size={17} />
              </ComposerIconButton>
              <button
                aria-label={canStop ? 'Stop' : 'Send message'}
                className="workplace-action shared-composer-submit"
                disabled={submitDisabled}
                onClick={canStop ? onStop : onSubmit}
                style={{
                  flex: 'none',
                  width: 36,
                  height: 36,
                  border: 'none',
                  borderRadius: '50%',
                  background: canSend || canStop ? 'var(--foreground)' : 'var(--secondary)',
                  color: canSend || canStop ? 'var(--background)' : 'var(--muted-foreground)',
                  cursor: canSend || canStop ? 'pointer' : 'not-allowed',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                type="button"
              >
                {canStop ? (
                  <Square
                    fill="currentColor"
                    size={16}
                  />
                ) : (
                  <ArrowUp size={18} />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </ChatInputChrome>
  );
}

function ContextUsageButton({
  percent,
  usage
}: {
  percent: number;
  usage?: {
    approximate?: boolean;
    limit: number;
    segments?: { category: string; color?: string; label: string; tokens: number }[];
    used: number;
  };
}): React.ReactElement {
  const circumference = 2 * Math.PI * 10;
  const dashOffset = circumference * (1 - percent / 100);

  return (
    <HoverCard
      closeDelay={80}
      openDelay={120}
    >
      <HoverCardTrigger asChild>
        <button
          aria-label="Context usage"
          className="workplace-action"
          style={{
            flex: 'none',
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: '50%',
            background: 'transparent',
            color: 'var(--foreground)',
            cursor: usage ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          type="button"
        >
          <svg
            height="18"
            role="img"
            viewBox="0 0 24 24"
            width="18"
          >
            <title>Context usage</title>
            <circle
              cx="12"
              cy="12"
              fill="none"
              opacity="0.25"
              r="10"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle
              cx="12"
              cy="12"
              fill="none"
              opacity="0.78"
              r="10"
              stroke="currentColor"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth="2"
              style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
            />
          </svg>
        </button>
      </HoverCardTrigger>
      {usage ? (
        <HoverCardContent
          align="end"
          className="w-72 p-0"
        >
          <div className="flex items-center justify-between gap-3 border-b p-3 text-xs">
            <span>{percent}% context used</span>
            <span className="font-mono text-muted-foreground">
              {formatCompact(usage.used)} / {formatCompact(usage.limit)}
              {usage.approximate ? ' ~' : ''}
            </span>
          </div>
          {usage.segments && usage.segments.length > 0 ? (
            <div className="flex flex-col gap-2 p-3">
              {usage.segments.map((segment) => (
                <div
                  className="flex items-center justify-between gap-4 text-xs"
                  key={`${segment.category}-${segment.label}`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <span
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: segment.color ?? 'hsl(215 16% 47% / 0.65)' }}
                    />
                    <span className="truncate">{segment.label}</span>
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">{segment.tokens.toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : null}
        </HoverCardContent>
      ) : null}
    </HoverCard>
  );
}

function ComposerSelect({
  ariaLabel,
  children,
  disabled = false,
  icon,
  onChange,
  tone = 'accent',
  value
}: {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  onChange?: (value: string) => void;
  tone?: 'accent' | 'ink';
  value: string;
}): React.ReactElement {
  return (
    <label
      className="workplace-action shared-composer-pill"
      style={{
        flex: 'none',
        minHeight: 32,
        border: 'none',
        borderRadius: 999,
        background: 'var(--shared-composer-control-bg, transparent)',
        color: disabled ? 'var(--muted-foreground)' : tone === 'ink' ? 'var(--foreground)' : 'var(--accent-blue)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 var(--shared-composer-pill-x, 7px)',
        fontFamily: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
        fontSize: 'var(--shared-composer-font-size, 14px)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.62 : 1
      }}
    >
      {icon}
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => onChange?.(event.currentTarget.value)}
        style={{
          appearance: 'none',
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: disabled ? 'not-allowed' : 'pointer',
          font: 'inherit',
          outline: 'none'
        }}
        value={value}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        size={14}
      />
    </label>
  );
}

function ComposerIconButton({
  active = false,
  ariaLabel,
  children,
  disabled = false,
  onClick
}: {
  active?: boolean;
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <button
      aria-label={ariaLabel}
      className="workplace-action"
      disabled={disabled}
      onClick={onClick}
      style={{
        flex: 'none',
        width: 34,
        height: 34,
        border: 'none',
        borderRadius: '50%',
        background: active ? 'var(--accent-blue-soft)' : 'var(--shared-composer-control-bg, transparent)',
        color: active ? 'var(--accent-blue)' : 'var(--muted-foreground)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.48 : 1
      }}
      type="button"
    >
      {children}
    </button>
  );
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
