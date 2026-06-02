import type { SessionId } from '@monad/protocol';
import type { SetStateAction } from 'react';
import type { StoreApi } from 'zustand';
import type { SkillEditorState } from '#/features/studio/skills-settings/types';
import type { MessageAttachmentView } from './message-attachment-view';
import type { SessionTranscriptRenderMode } from './session-route-contract';

import { createContext, useContext } from 'react';
import { createStore, useStore } from 'zustand';

type CommandInsertItem = {
  insert: string;
  replace?: { start: number; end: number };
};

type HiddenViewMap = Record<SessionId, string[]>;
export interface InitialUserMessage {
  attachments?: MessageAttachmentView[];
  text: string;
}
type InitialUserMessageMap = Record<SessionId, InitialUserMessage[]>;

export interface SessionUiState {
  input: string;
  accessMode: 'auto' | 'ask';
  atBottom: boolean;
  activeSkill: number;
  transcriptRenderMode: SessionTranscriptRenderMode;
  hiddenViewItemKeysBySession: HiddenViewMap;
  initialUserMessagesBySession: InitialUserMessageMap;
  skillPreview: SkillEditorState | null;
  skillMenuDismissed: boolean;
  replyTargetId: string | null;
  replyGeneration: number;
  setComposerInput: (value: string) => void;
  clearComposerInput: () => void;
  appendVoiceText: (text: string) => void;
  applyCommandInsert: (item: CommandInsertItem) => void;
  enqueueInitialUserMessage: (sessionId: SessionId, message: InitialUserMessage) => void;
  clearInitialUserMessages: (sessionId: SessionId) => void;
  setAccessMode: (mode: 'auto' | 'ask') => void;
  setAtBottom: (value: boolean) => void;
  setActiveSkill: (skill: SetStateAction<number>) => void;
  setTranscriptRenderMode: (mode: SessionTranscriptRenderMode) => void;
  setHiddenViewItemKeysBySession: (updater: (prev: HiddenViewMap) => HiddenViewMap) => void;
  setSkillPreview: (preview: SkillEditorState | null) => void;
  setSkillMenuDismissed: (dismissed: SetStateAction<boolean>) => void;
  setReplyTargetId: (targetId: string | null) => void;
  finishReplySend: (generation: number, succeeded: boolean) => void;
}

function createSessionUiStore(): StoreApi<SessionUiState> {
  return createStore<SessionUiState>()((set) => ({
    input: '',
    accessMode: 'auto',
    atBottom: true,
    activeSkill: 0,
    transcriptRenderMode: 'detail',
    hiddenViewItemKeysBySession: {},
    initialUserMessagesBySession: {},
    skillPreview: null,
    skillMenuDismissed: false,
    replyTargetId: null,
    replyGeneration: 0,
    setComposerInput: (value) => set({ input: value }),
    clearComposerInput: () => set({ input: '' }),
    appendVoiceText: (text) =>
      set((state) => ({
        input: state.input.length > 0 ? `${state.input} ${text}` : text
      })),
    applyCommandInsert: (item) =>
      set((state) => {
        if (item.replace) {
          return {
            input: `${state.input.slice(0, item.replace.start)}${item.insert}${state.input.slice(item.replace.end)}`
          };
        }
        return {
          input: state.input.length > 0 ? `${state.input}${item.insert}` : item.insert
        };
      }),
    enqueueInitialUserMessage: (sessionId, message) =>
      set((state) => ({
        initialUserMessagesBySession: {
          ...state.initialUserMessagesBySession,
          [sessionId]: [...(state.initialUserMessagesBySession[sessionId] ?? []), message]
        }
      })),
    clearInitialUserMessages: (sessionId) =>
      set((state) => {
        const next = { ...state.initialUserMessagesBySession };
        delete next[sessionId];
        return { initialUserMessagesBySession: next };
      }),
    setAccessMode: (mode) => set({ accessMode: mode }),
    setAtBottom: (value) => set({ atBottom: value }),
    setActiveSkill: (skill) =>
      set((state) => ({
        activeSkill: typeof skill === 'function' ? skill(state.activeSkill) : skill
      })),
    setTranscriptRenderMode: (mode) => set({ transcriptRenderMode: mode }),
    setHiddenViewItemKeysBySession: (updater) =>
      set((state) => ({
        hiddenViewItemKeysBySession: updater(state.hiddenViewItemKeysBySession)
      })),
    setSkillPreview: (preview) => set({ skillPreview: preview }),
    setReplyTargetId: (replyTargetId) =>
      set((state) => ({
        replyGeneration: state.replyGeneration + 1,
        replyTargetId
      })),
    finishReplySend: (generation, succeeded) =>
      set((state) =>
        succeeded && state.replyGeneration === generation
          ? { replyGeneration: state.replyGeneration + 1, replyTargetId: null }
          : state
      ),
    setSkillMenuDismissed: (dismissed) =>
      set((state) => ({
        skillMenuDismissed: typeof dismissed === 'function' ? dismissed(state.skillMenuDismissed) : dismissed
      }))
  }));
}

const fallbackSessionUiStore = createSessionUiStore();
const sessionUiStores = new Map<string, StoreApi<SessionUiState>>();

export const SessionUiStoreContext = createContext<StoreApi<SessionUiState> | null>(null);

export function getSessionUiStore(sessionId: string): StoreApi<SessionUiState> {
  const existing = sessionUiStores.get(sessionId);
  if (existing) return existing;
  const store = createSessionUiStore();
  sessionUiStores.set(sessionId, store);
  return store;
}

export function enqueueInitialUserMessageForSession(sessionId: SessionId, message: InitialUserMessage): void {
  getSessionUiStore(sessionId).getState().enqueueInitialUserMessage(sessionId, message);
}

export function removeSessionUiStore(sessionId: string): void {
  sessionUiStores.delete(sessionId);
}

function useContextSessionUiStore<T>(selector: (state: SessionUiState) => T): T {
  const store = useContext(SessionUiStoreContext) ?? fallbackSessionUiStore;
  return useStore(store, selector);
}

export const useSessionUiStore = Object.assign(useContextSessionUiStore, {
  getState: fallbackSessionUiStore.getState,
  setState: fallbackSessionUiStore.setState,
  subscribe: fallbackSessionUiStore.subscribe
});

export function useSessionUiStoreForSession<T>(sessionId: SessionId | null, selector: (state: SessionUiState) => T): T {
  return useStore(sessionId ? getSessionUiStore(sessionId) : fallbackSessionUiStore, selector);
}
