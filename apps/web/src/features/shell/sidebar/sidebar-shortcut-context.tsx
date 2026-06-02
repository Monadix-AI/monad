import type { ReactNode } from 'react';

import { createContext, useContext } from 'react';

interface SidebarShortcutAllocator {
  assignments: Map<string, number>;
  next: number;
}

const SidebarShortcutAllocatorContext = createContext<SidebarShortcutAllocator | null>(null);

export function SidebarShortcutAllocatorProvider({ children }: { children: ReactNode }) {
  return (
    <SidebarShortcutAllocatorContext value={{ assignments: new Map(), next: 0 }}>
      {children}
    </SidebarShortcutAllocatorContext>
  );
}

export function useSidebarSessionShortcutValue(rowKey: string): number | undefined {
  const allocator = useContext(SidebarShortcutAllocatorContext);
  if (!allocator) return undefined;
  const assigned = allocator.assignments.get(rowKey);
  if (assigned !== undefined) return assigned;
  if (allocator.next >= 9) return undefined;
  allocator.next += 1;
  allocator.assignments.set(rowKey, allocator.next);
  return allocator.next;
}
