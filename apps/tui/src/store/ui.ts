import { create } from 'zustand';

type Overlay = 'none' | 'session-picker' | 'settings' | 'interaction';

interface UIState {
  input: string;
  isConnected: boolean;
  overlay: Overlay;
  setInput: (v: string) => void;
  setConnected: (v: boolean) => void;
  setOverlay: (v: Overlay) => void;
}

export const useUIStore = create<UIState>((set) => ({
  input: '',
  isConnected: false,
  overlay: 'session-picker', // start with picker visible
  setInput: (v) => set({ input: v }),
  setConnected: (v) => set({ isConnected: v }),
  setOverlay: (v) => set({ overlay: v })
}));
