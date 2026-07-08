'use client';

import type { SessionId } from '@monad/protocol';
import type { SetStateAction } from 'react';

import { create } from 'zustand';

type CommandInsertItem = {
  insert: string;
};

type HiddenViewMap = Record<SessionId, string[]>;

export interface SessionUiState {
  input: string;
  accessMode: 'auto' | 'ask';
  atBottom: boolean;
  activeSkill: number;
  hiddenViewItemKeysBySession: HiddenViewMap;
  skillMenuDismissed: boolean;
  setComposerInput: (value: string) => void;
  clearComposerInput: () => void;
  appendVoiceText: (text: string) => void;
  applyCommandInsert: (item: CommandInsertItem) => void;
  setAccessMode: (mode: 'auto' | 'ask') => void;
  setAtBottom: (value: boolean) => void;
  setActiveSkill: (skill: SetStateAction<number>) => void;
  setHiddenViewItemKeysBySession: (updater: (prev: HiddenViewMap) => HiddenViewMap) => void;
  setSkillMenuDismissed: (dismissed: SetStateAction<boolean>) => void;
}

export const useSessionUiStore = create<SessionUiState>()((set) => ({
  input: '',
  accessMode: 'auto',
  atBottom: true,
  activeSkill: 0,
  hiddenViewItemKeysBySession: {},
  skillMenuDismissed: false,
  setComposerInput: (value) => set({ input: value }),
  clearComposerInput: () => set({ input: '' }),
  appendVoiceText: (text) =>
    set((state) => ({
      input: state.input.length > 0 ? `${state.input} ${text}` : text
    })),
  applyCommandInsert: (item) =>
    set((state) => ({
      input: state.input.length > 0 ? `${state.input}${item.insert}` : item.insert
    })),
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
  setSkillMenuDismissed: (dismissed) =>
    set((state) => ({
      skillMenuDismissed: typeof dismissed === 'function' ? dismissed(state.skillMenuDismissed) : dismissed
    }))
}));
