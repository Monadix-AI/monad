import type { CSSProperties, DragEvent as ReactDragEvent, ReactElement } from 'react';
import type { ChatRoomCanvas } from '../utils/canvas.ts';
import type { ProjectComposerDirective, ProjectComposerSurface } from '../utils/composer.ts';

import { Attachment01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui/lib/utils';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { workplaceExperienceT } from '../../i18n.ts';
import {
  createOptimisticUserMessage,
  mergeOptimisticMessages,
  type OptimisticChatMessage
} from '../utils/optimistic-messages.ts';
import { AgentTasksRail } from './agent-tasks-rail.tsx';
import { ChatTranscript } from './chat-transcript.tsx';
import { Composer, type ComposerDroppedFiles } from './composer/composer.tsx';

export type ChatRoomExperienceRuntime = {
  canvas: ChatRoomCanvas;
  composer: ProjectComposerSurface;
};

type ProjectReplySelection = {
  generation: number;
  targetId: string;
};

function projectReplySelectionAfterSend(
  current: ProjectReplySelection | null,
  generation: number | undefined,
  replyToMessageId: string | undefined
): ProjectReplySelection | null {
  return current && current.generation === generation && current.targetId === replyToMessageId ? null : current;
}

function resolveProjectReplyTarget(
  selection: ProjectReplySelection,
  messages: readonly import('../../experience/types.ts').Message[],
  replyTargets: ReadonlyMap<string, import('../../experience/types.ts').Message | null>
): import('../../experience/types.ts').Message | null;
function resolveProjectReplyTarget(
  selection: null,
  messages: readonly import('../../experience/types.ts').Message[],
  replyTargets: ReadonlyMap<string, import('../../experience/types.ts').Message | null>
): undefined;
function resolveProjectReplyTarget(
  selection: ProjectReplySelection | null,
  messages: readonly import('../../experience/types.ts').Message[],
  replyTargets: ReadonlyMap<string, import('../../experience/types.ts').Message | null>
): import('../../experience/types.ts').Message | null | undefined;
function resolveProjectReplyTarget(
  selection: ProjectReplySelection | null,
  messages: readonly import('../../experience/types.ts').Message[],
  replyTargets: ReadonlyMap<string, import('../../experience/types.ts').Message | null>
): import('../../experience/types.ts').Message | null | undefined {
  if (!selection) return undefined;
  return messages.find((message) => message.id === selection.targetId) ?? replyTargets.get(selection.targetId) ?? null;
}

function filesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  return [...dataTransfer.files];
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer ? [...dataTransfer.types].includes('Files') : false;
}

export function ChatRoomExperienceView({ runtime }: { runtime: ChatRoomExperienceRuntime }): ReactElement {
  const room = runtime.canvas;
  const t = workplaceExperienceT();
  const dropSurfaceRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(132);
  const [dropActive, setDropActive] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<ComposerDroppedFiles | undefined>(undefined);
  const optimisticIdRef = useRef(0);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticChatMessage[]>([]);
  const replyGenerationRef = useRef(0);
  const [replySelection, setReplySelection] = useState<ProjectReplySelection | null>(null);
  const [requestedMessageId, setRequestedMessageId] = useState<string | null>(null);
  const human = room.human;
  const sendOptimisticDirective = useCallback(
    async (directive: ProjectComposerDirective, existingId?: string) => {
      const text = typeof directive === 'string' ? directive : directive.text;
      const attachments = typeof directive === 'string' ? undefined : directive.attachments;
      const replyToMessageId = typeof directive === 'string' ? undefined : directive.replyToMessageId;
      const replyGeneration = typeof directive === 'string' ? undefined : directive.replyGeneration;
      const trimmed = text.trim();
      if (!trimmed && !attachments?.length) return;
      const id = existingId ?? `optimistic:${Date.now()}:${optimisticIdRef.current++}`;
      const retry = () =>
        void sendOptimisticDirective({ attachments, replyGeneration, replyToMessageId, text: trimmed }, id);
      const optimisticMessage = createOptimisticUserMessage({
        attachments,
        human,
        id,
        precedingMessageId: room.messages.at(-1)?.id,
        replyToMessageId,
        retry,
        status: 'sending',
        text: trimmed
      });
      setOptimisticMessages((messages) => {
        const exists = messages.some((message) => message.id === id);
        if (exists) return messages.map((message) => (message.id === id ? optimisticMessage : message));
        return [...messages, optimisticMessage];
      });
      try {
        await runtime.composer.sendDirective({ attachments, replyToMessageId, text: trimmed });
        setOptimisticMessages((messages) =>
          messages.map((message) => (message.id === id ? { ...message, localStatus: 'sent' } : message))
        );
        setReplySelection((current) => projectReplySelectionAfterSend(current, replyGeneration, replyToMessageId));
      } catch {
        setOptimisticMessages((messages) =>
          messages.map((message) =>
            message.id === id ? { ...message, localStatus: 'failed', retrySend: retry } : message
          )
        );
      }
    },
    [human, room.messages, runtime.composer]
  );
  const messages = useMemo(
    () => mergeOptimisticMessages(room.messages, optimisticMessages),
    [room.messages, optimisticMessages]
  );
  const replyTarget = useMemo(
    () => resolveProjectReplyTarget(replySelection, messages, room.replyTargets),
    [messages, replySelection, room.replyTargets]
  );
  const chatRoom = useMemo(
    () => ({
      ...room,
      messages,
      onReply: (target: import('../../experience/types.ts').Message) => {
        replyGenerationRef.current += 1;
        setReplySelection({ generation: replyGenerationRef.current, targetId: target.id });
      },
      onRequestedMessageResolved: () => setRequestedMessageId(null),
      requestedMessageId
    }),
    [messages, requestedMessageId, room]
  );
  const composer = useMemo(
    () => ({
      ...runtime.composer,
      cancelReply: () => setReplySelection(null),
      openReplyTarget: () => {
        if (replySelection && replyTarget) setRequestedMessageId(replySelection.targetId);
      },
      replyGeneration: replySelection?.generation,
      replyTarget,
      replyToMessageId: replySelection?.targetId,
      sendDirective: sendOptimisticDirective
    }),
    [replySelection, replyTarget, runtime.composer, sendOptimisticDirective]
  );

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    const updateComposerHeight = () => setComposerHeight(Math.ceil(node.getBoundingClientRect().height));
    updateComposerHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const resizeObserver = new ResizeObserver(updateComposerHeight);
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const handleWindowDragOver = (event: DragEvent): void => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      setDropActive(true);
      const target = event.target instanceof Node ? event.target : null;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = target && dropSurfaceRef.current?.contains(target) ? 'copy' : 'none';
      }
    };
    const handleWindowDrop = (event: DragEvent): void => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      const target = event.target instanceof Node ? event.target : null;
      const insideDropSurface = Boolean(target && dropSurfaceRef.current?.contains(target));
      event.preventDefault();
      event.stopPropagation();
      setDropActive(false);
      if (!insideDropSurface) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
        return;
      }
      const files = filesFromDataTransfer(event.dataTransfer);
      if (!files.length) return;
      setDroppedFiles({ files, nonce: Date.now() });
    };
    const handleWindowDragLeave = (event: DragEvent): void => {
      if (event.relatedTarget === null) setDropActive(false);
    };
    const clearDropActive = (): void => setDropActive(false);
    window.addEventListener('dragover', handleWindowDragOver, true);
    window.addEventListener('drop', handleWindowDrop, true);
    window.addEventListener('dragleave', handleWindowDragLeave, true);
    window.addEventListener('dragend', clearDropActive, true);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver, true);
      window.removeEventListener('drop', handleWindowDrop, true);
      window.removeEventListener('dragleave', handleWindowDragLeave, true);
      window.removeEventListener('dragend', clearDropActive, true);
    };
  }, []);

  const handleDropSurfaceDrag = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  };
  const handleDropSurfaceDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    const files = filesFromDataTransfer(event.dataTransfer);
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    if (!files.length) return;
    setDroppedFiles({ files, nonce: Date.now() });
  };

  const transcriptStyle = useMemo(
    () =>
      ({
        '--chat-room-composer-clearance': `${composerHeight}px`
      }) as CSSProperties,
    [composerHeight]
  );

  return createElement(
    'div',
    { className: cn('flex min-h-0 min-w-0 flex-1') },
    createElement(
      'div',
      {
        className: cn('relative flex min-h-0 min-w-0 flex-1 overflow-hidden'),
        onDragEnterCapture: handleDropSurfaceDrag,
        onDragOverCapture: handleDropSurfaceDrag,
        onDropCapture: handleDropSurfaceDrop,
        ref: dropSurfaceRef
      },
      createElement(
        'div',
        { className: cn('flex min-h-0 flex-1 flex-col'), style: transcriptStyle },
        createElement(ChatTranscript, {
          labels: {
            connectInStudio: t('web.workplace.emptyConnectInStudio'),
            directMessageContent: t('web.workplace.directMessageContent'),
            directMessageSent: (from: string, to: string) => t('web.workplace.directMessageSent', { from, to }),
            emptyDescription: t('web.workplace.emptyChatDescription'),
            emptyTitle: t('web.workplace.emptyChatTitle'),
            goToMessage: (label: string) => t('web.chat.goToMessage', { message: label }),
            jumpLatest: t('web.workplace.jumpLatest'),
            messageOutline: t('web.chat.messageOutline'),
            observe: t('web.workplace.observe'),
            reply: t('web.chat.reply'),
            replyUnavailable: t('web.chat.replyUnavailable'),
            retry: t('web.workplace.retryMessage'),
            sentFrom: t('web.chat.sentFrom'),
            originConversation: t('web.chat.originConversation'),
            originDirectMessage: t('web.chat.originDirectMessage'),
            originGroup: t('web.chat.originGroup'),
            originChannel: t('web.chat.originChannel'),
            originSender: t('web.chat.originSender'),
            originThread: t('web.chat.originThread'),
            originInstance: t('web.chat.originInstance'),
            originVersion: t('web.chat.originVersion'),
            spawnAgentMember: t('web.workplace.emptySpawnAgentMember'),
            systemMessage: t('web.workplace.systemMessage'),
            systemMessageDetails: t('web.workplace.systemMessageDetails'),
            timeUnavailable: t('web.chat.timeUnavailable'),
            waitingForResponse: t('web.workplace.waitingForResponse'),
            working: t('web.workplace.working')
          },
          room: chatRoom
        })
      ),
      createElement(
        'div',
        {
          // The fade behind the composer lives INSIDE the transcript scroller (its viewportOverlay):
          // painted there, the scroller's own overlay scrollbar renders on top of it. A background
          // here would sit above the scroller element and swallow the scrollbar thumb. Pointer
          // events stay off on this full-width strip for the same reason — only the composer itself
          // may catch clicks, never the scrollbar lane beside it.
          className: cn('pointer-events-none absolute right-0 bottom-0 left-0 z-20 pt-12'),
          ref: composerRef
        },
        createElement(
          'div',
          {
            className: cn('pointer-events-auto'),
            // Same centered content column as the transcript rows (message-list caps at 800px too).
            style: { boxSizing: 'border-box', margin: '0 auto', maxWidth: 800, padding: '0 16px', width: '100%' }
          },
          createElement(Composer, { droppedFiles, room: composer })
        )
      ),
      dropActive
        ? createElement(
            'div',
            {
              'aria-hidden': true,
              className: cn(
                'pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3'
              ),
              style: {
                background: 'color-mix(in srgb, var(--background) 62%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-blue) 48%, var(--border))',
                color: 'var(--foreground)',
                fontFamily: 'var(--font-ui)',
                fontSize: 18,
                fontWeight: 650
              }
            },
            createElement(HugeiconsIcon, { icon: Attachment01Icon, size: 30 }),
            'Drop here to add attachments'
          )
        : null
    ),
    createElement(AgentTasksRail, { room })
  );
}
