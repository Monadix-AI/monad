import type { CommandItem } from '@monad/protocol';
import type { ReactNode } from 'react';
import type { SessionIdentityModel } from './session-route-contract';

import { createContext, useContext } from 'react';

type SessionContextValue = {
  commands: CommandItem[];
  identity: SessionIdentityModel;
  onSkillPreview: (id: string) => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children, value }: { children: ReactNode; value: SessionContextValue }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionContext(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSessionContext must be used within SessionProvider');
  return context;
}

export function useOptionalSessionContext(): SessionContextValue | null {
  return useContext(SessionContext);
}
