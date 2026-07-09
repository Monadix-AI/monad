'use client';

import { create } from 'zustand';

const SHOW_DEV_SYSTEM_MESSAGES_IN_STREAM_KEY = 'monad.workplace.showDevSystemMessagesInStream';

export const DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED = process.env.NODE_ENV !== 'production';

function readShowDevSystemMessagesInStream(): boolean {
  if (!DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED || typeof window === 'undefined') return false;
  return window.localStorage.getItem(SHOW_DEV_SYSTEM_MESSAGES_IN_STREAM_KEY) === 'true';
}

interface ProjectDebugState {
  showDevSystemMessagesInStream: boolean;
  setShowDevSystemMessagesInStream: (show: boolean) => void;
}

export const useProjectDebugStore = create<ProjectDebugState>((set) => ({
  showDevSystemMessagesInStream: readShowDevSystemMessagesInStream(),
  setShowDevSystemMessagesInStream: (show) => {
    if (!DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED) return;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SHOW_DEV_SYSTEM_MESSAGES_IN_STREAM_KEY, String(show));
    }
    set({ showDevSystemMessagesInStream: show });
  }
}));
