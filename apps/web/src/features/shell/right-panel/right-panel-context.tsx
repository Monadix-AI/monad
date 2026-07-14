import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

import {
  activateRightPanelOwner,
  canRenderRightPanelContent,
  createRightPanelOwnership,
  type RightPanelOwnerId,
  registerRightPanelContent,
  unregisterRightPanelContent
} from './right-panel-ownership';

type RightPanelContextValue = {
  slot: HTMLElement | null;
  setSlot: (element: HTMLElement | null) => void;
  activeOwnerId: RightPanelOwnerId;
  canRenderContent: (ownerId: string, registrationId: string) => boolean;
  registerContent: (ownerId: string, registrationId: string) => () => void;
};

const RightPanelContext = createContext<RightPanelContextValue | null>(null);

export function RightPanelProvider({ children, ownerId }: { children: ReactNode; ownerId: RightPanelOwnerId }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [ownership, setOwnership] = useState(() => createRightPanelOwnership(ownerId));
  const activeOwnerIdRef = useRef(ownerId);
  activeOwnerIdRef.current = ownerId;
  const activeOwnership = activateRightPanelOwner(ownership, ownerId);

  const registerContent = useCallback((contentOwnerId: string, registrationId: string) => {
    setOwnership((state) =>
      registerRightPanelContent(
        activateRightPanelOwner(state, activeOwnerIdRef.current),
        contentOwnerId,
        registrationId
      )
    );
    return () => setOwnership((state) => unregisterRightPanelContent(state, registrationId));
  }, []);
  const canRenderContent = useCallback(
    (contentOwnerId: string, registrationId: string) =>
      canRenderRightPanelContent(activeOwnership, contentOwnerId, registrationId),
    [activeOwnership]
  );
  const value = useMemo<RightPanelContextValue>(
    () => ({
      slot,
      setSlot,
      activeOwnerId: activeOwnership.activeOwnerId,
      canRenderContent,
      registerContent
    }),
    [slot, activeOwnership.activeOwnerId, canRenderContent, registerContent]
  );

  return <RightPanelContext.Provider value={value}>{children}</RightPanelContext.Provider>;
}

export function useRightPanel(): RightPanelContextValue {
  const value = useContext(RightPanelContext);
  if (!value) throw new Error('useRightPanel must be used within RightPanelProvider');
  return value;
}
