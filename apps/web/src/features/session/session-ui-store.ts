import type { SessionId } from '@monad/protocol';
import type { SetStateAction } from 'react';
import type { StoreApi } from 'zustand';
import type { SkillEditorState } from '#/features/studio/skills-settings/types';
import type { SessionTranscriptRenderMode } from './session-route-contract';

import { createContext, useContext } from 'react';
import { createStore, useStore } from 'zustand';

type CommandInsertItem = {
  insert: string;
  replace?: { start: number; end: number };
};

type HiddenViewMap = Record<SessionId, string[]>;
type InitialUserMessageMap = Record<SessionId, string[]>;

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
  setComposerInput: (value: string) => void;
  clearComposerInput: () => void;
  appendVoiceText: (text: string) => void;
  applyCommandInsert: (item: CommandInsertItem) => void;
  enqueueInitialUserMessage: (sessionId: SessionId, text: string) => void;
  clearInitialUserMessages: (sessionId: SessionId) => void;
  setAccessMode: (mode: 'auto' | 'ask') => void;
  setAtBottom: (value: boolean) => void;
  setActiveSkill: (skill: SetStateAction<number>) => void;
  setTranscriptRenderMode: (mode: SessionTranscriptRenderMode) => void;
  setHiddenViewItemKeysBySession: (updater: (prev: HiddenViewMap) => HiddenViewMap) => void;
  setSkillPreview: (preview: SkillEditorState | null) => void;
  setSkillMenuDismissed: (dismissed: SetStateAction<boolean>) => void;
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
    enqueueInitialUserMessage: (sessionId, text) =>
      set((state) => ({
        initialUserMessagesBySession: {
          ...state.initialUserMessagesBySession,
          [sessionId]: [...(state.initialUserMessagesBySession[sessionId] ?? []), text]
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
