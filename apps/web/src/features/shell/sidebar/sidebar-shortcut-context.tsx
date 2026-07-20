import type { ReactNode } from 'react';

import { createContext, useContext } from 'react';

interface SidebarShortcutAllocator {
  next: number;
}

const SidebarShortcutAllocatorContext = createContext<SidebarShortcutAllocator | null>(null);

export function SidebarShortcutAllocatorProvider({ children }: { children: ReactNode }) {
  return <SidebarShortcutAllocatorContext value={{ next: 0 }}>{children}</SidebarShortcutAllocatorContext>;
}

export function useSidebarSessionShortcutValue(): number | undefined {
  const allocator = useContext(SidebarShortcutAllocatorContext);
  if (!allocator || allocator.next >= 9) return undefined;
  allocator.next += 1;
  return allocator.next;
}
