'use client';

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

type RightPanelContextValue = {
  slot: HTMLElement | null;
  setSlot: (element: HTMLElement | null) => void;
  hasContent: boolean;
  registerContent: () => () => void;
};

const RightPanelContext = createContext<RightPanelContextValue | null>(null);

// Owns the portal target that routes render right-panel content into, plus a
// content-presence counter so the shared column only takes layout width while a
// route actually has something to show — a stale open flag never leaves an empty rail.
export function RightPanelProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [contentCount, setContentCount] = useState(0);

  const registerContent = useCallback(() => {
    setContentCount((count) => count + 1);
    return () => setContentCount((count) => Math.max(0, count - 1));
  }, []);

  const value = useMemo<RightPanelContextValue>(
    () => ({ slot, setSlot, hasContent: contentCount > 0, registerContent }),
    [slot, contentCount, registerContent]
  );

  return <RightPanelContext.Provider value={value}>{children}</RightPanelContext.Provider>;
}

export function useRightPanel(): RightPanelContextValue {
  const value = useContext(RightPanelContext);
  if (!value) throw new Error('useRightPanel must be used within RightPanelProvider');
  return value;
}
