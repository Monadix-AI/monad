'use client';

import type { SessionId } from '@monad/protocol';
import type { SetStateAction } from 'react';
import type { SkillEditorState } from '#/features/studio/skills-settings/types';

import { create } from 'zustand';

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
  setHiddenViewItemKeysBySession: (updater: (prev: HiddenViewMap) => HiddenViewMap) => void;
  setSkillPreview: (preview: SkillEditorState | null) => void;
  setSkillMenuDismissed: (dismissed: SetStateAction<boolean>) => void;
}

export const useSessionUiStore = create<SessionUiState>()((set) => ({
  input: '',
  accessMode: 'auto',
  atBottom: true,
  activeSkill: 0,
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
