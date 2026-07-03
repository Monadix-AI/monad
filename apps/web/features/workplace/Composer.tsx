import type { QuestionView } from './types';
import type { ProjectController } from './use-project';

import {
  profileSelectors,
  useGetRolesQuery,
  useListProfilesQuery,
  useTranscribeAudioMutation
} from '@monad/client-rtk';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';

import { studioPath } from '@/features/routes/route-paths';
import { ComposerShell } from '@/features/session/ComposerShell';
import { audioBlobToBase64 } from '@/features/session/voice-transcription';
import { ApprovalStack } from './activity/ApprovalStack';
import {
  activeMention,
  createMentionChip,
  domPointAt,
  insertPlainText,
  renderSerializedEditor,
  serializeEditor,
  textBeforeCaret
} from './composer-editor';
import { QuestionStack } from './QuestionStack';
import { mono, sans } from './styles';

export function Composer({ room }: { room: ProjectController }): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: modelRoles } = useGetRolesQuery(undefined);
  const { data: profileData } = useListProfilesQuery(undefined);
  const profiles = profileData ? profileSelectors.selectAll(profileData.profiles) : [];
  const defaultProfile = profiles.find((profile) => profile.alias === profileData?.defaultAlias);
  const [transcribeAudio] = useTranscribeAudioMutation();
  const [draft, setDraft] = useState('');
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const [accessMode, setAccessMode] = useState<'auto' | 'ask'>('auto');
  const [submitting, setSubmitting] = useState(false);
  const [askPanelTestAnswered, setAskPanelTestAnswered] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const submittingTextRef = useRef<string | null>(null);

  const options = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return room.mentionTargets.filter((target) => target.name.toLowerCase().startsWith(q));
  }, [mention, room.mentionTargets]);
  const menuOpen = mention !== null && options.length > 0;
  const testQuestion: QuestionView | null =
    searchParams.get('askPanelTest') === '1' && !askPanelTestAnswered
      ? {
          id: 'clarify_preview',
          askerName: 'Lily',
          question: 'Which direction should I take for the next step?',
          options: ['Tighten the UI', 'Check the agent flow', 'Ship the current version'],
          mode: 'multiple',
          allowOther: true
        }
      : null;
  const activeQuestion = room.questions[0] ?? testQuestion;
  const questionAsker = activeQuestion
    ? room.participants.find((participant) => participant.name === activeQuestion.askerName)
    : undefined;
  const answerQuestion = (requestId: string, answer: string): void => {
    if (requestId === 'clarify_preview') {
      setAskPanelTestAnswered(true);
      return;
    }
    room.answerQuestion(requestId, answer);
  };

  const syncMention = (value: string, caret: number): void => {
    const m = activeMention(value, caret);
    if (!mention || !m || mention.start !== m.start) setActive(0);
    setMention(m);
  };

  const syncFromEditor = (): void => {
    const editor = editorRef.current;
    if (!editor) return;
    setDraft(serializeEditor(editor));
    syncMention(textBeforeCaret(editor), textBeforeCaret(editor).length);
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) return;
    if (sendingRef.current) return;
    if (submittingTextRef.current === text) return;
    sendingRef.current = true;
    submittingTextRef.current = text;
    setSubmitting(true);
    setDraft('');
    setMention(null);
    if (editorRef.current) editorRef.current.textContent = '';
    try {
      await room.sendDirective(text);
    } catch {
      setDraft((current) => (current ? current : text));
      if (editorRef.current) renderSerializedEditor(editorRef.current, text);
    } finally {
      submittingTextRef.current = null;
      sendingRef.current = false;
      setSubmitting(false);
      editorRef.current?.focus();
    }
  };

  const acceptMention = (target: { id: string; name: string }): void => {
    if (!mention) return;
    const editor = editorRef.current;
    if (!editor) return;
    const before = textBeforeCaret(editor);
    const start = mention.start;
    const end = before.length;
    const range = document.createRange();
    const from = domPointAt(editor, start);
    const to = domPointAt(editor, end);
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    range.deleteContents();
    const space = document.createTextNode(' ');
    range.insertNode(space);
    range.insertNode(createMentionChip(target));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const caret = document.createRange();
    caret.setStartAfter(space);
    caret.collapse(true);
    selection?.addRange(caret);
    setDraft(serializeEditor(editor));
    setMention(null);
  };

  return (
    <div
      style={{
        flex: 'none',
        position: 'relative'
      }}
    >
      {activeQuestion ? (
        <div
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: '100%',
            marginBottom: 8,
            zIndex: 20,
            maxHeight: 'min(52vh, 420px)',
            overflowY: 'auto'
          }}
        >
          <QuestionStack
            asker={questionAsker}
            key={activeQuestion.id}
            onAnswer={answerQuestion}
            question={activeQuestion}
          />
        </div>
      ) : null}
      <ApprovalStack room={room} />

      <div style={{ padding: '14px 16px 18px' }}>
        <ComposerShell
          access={{
            mode: accessMode,
            onChange: setAccessMode
          }}
          ariaLabel="Message agents"
          busy={Boolean(room.typing)}
          contextUsage={
            room.contextUsage
              ? {
                  approximate: room.contextUsage.approximate,
                  limit: room.contextUsage.contextLimit,
                  segments: room.contextUsage.segments,
                  used: room.contextUsage.used
                }
              : undefined
          }
          controls={{ access: false, context: false, model: false, submit: true, voice: true }}
          disabled={submitting}
          editorSlot={
            // biome-ignore lint/a11y/useSemanticElements: contenteditable is required for inline atomic mention chips.
            <div
              aria-label="Message agents"
              aria-multiline
              className="max-h-40 min-h-16 overflow-y-auto px-4 pt-3.5 pb-2 text-[15px] leading-relaxed outline-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]"
              contentEditable={!submitting}
              data-placeholder="Ask for follow-up changes"
              onBlur={() => setMention(null)}
              onDrop={(e) => {
                e.preventDefault();
                const text = e.dataTransfer.getData('text/plain');
                if (text) insertPlainText(text);
                syncFromEditor();
              }}
              onInput={syncFromEditor}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (menuOpen) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((i) => (i + 1) % options.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((i) => (i - 1 + options.length) % options.length);
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    const target = options[active];
                    if (target) acceptMention(target);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              onKeyUp={() => syncFromEditor()}
              onPaste={(e) => {
                e.preventDefault();
                insertPlainText(e.clipboardData.getData('text/plain'));
                syncFromEditor();
              }}
              ref={editorRef}
              role="textbox"
              suppressContentEditableWarning
              tabIndex={0}
            />
          }
          mentionMenu={
            menuOpen ? (
              <div
                className="glass-surface"
                style={{
                  position: 'absolute',
                  left: 18,
                  bottom: 10,
                  minWidth: 180,
                  overflow: 'hidden',
                  zIndex: 60
                }}
              >
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 1,
                    color: 'var(--muted-foreground)',
                    padding: '6px 10px 2px'
                  }}
                >
                  Choose an agent
                </div>
                {options.map((target, i) => (
                  <button
                    className="workplace-action"
                    key={target.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptMention(target);
                    }}
                    onMouseEnter={() => setActive(i)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      border: 'none',
                      fontFamily: sans,
                      fontSize: 14,
                      fontWeight: 500,
                      padding: '6px 10px',
                      color: i === active ? 'var(--accent-foreground)' : 'var(--foreground)',
                      background:
                        i === active ? 'color-mix(in srgb, var(--accent-blue) 30%, var(--card))' : 'transparent'
                    }}
                    type="button"
                  >
                    @{target.name}
                  </button>
                ))}
              </div>
            ) : null
          }
          model={{
            current: room.modelProfiles[0]?.alias,
            onChange: (alias) => {
              if (!alias) return;
              room.sendDirective(`/model ${alias}`);
            },
            options: room.modelProfiles.map((profile) => ({ label: profile.alias, value: profile.alias }))
          }}
          onStop={room.pauseAll}
          onSubmit={submit}
          onVoiceText={(text) => {
            const editor = editorRef.current;
            if (editor) {
              editor.append(document.createTextNode(`${editor.textContent?.trim() ? ' ' : ''}${text}`));
              setDraft(serializeEditor(editor));
            }
            setMention(null);
          }}
          placeholder="Ask for follow-up changes"
          value={draft}
          voice={{
            modelConfigured: Boolean(
              modelRoles?.transcription && defaultProfile?.routes.chat.provider && defaultProfile.routes.chat.modelId
            ),
            onSettingsClick: () => router.push(studioPath('models')),
            transcribeAudio: async (audio) => {
              const body = await audioBlobToBase64(audio);
              return (await transcribeAudio(body).unwrap()).text;
            }
          }}
        />
      </div>
    </div>
  );
}
