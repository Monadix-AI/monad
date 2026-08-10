import type { PropsWithChildren } from 'react';

import { ScrollShadow } from '@monad/ui';

export function SidebarScrollArea({ children }: PropsWithChildren) {
  return (
    <ScrollShadow
      className="sidebar-scroll-area min-h-0 flex-1"
      size={20}
    >
      {children}
    </ScrollShadow>
  );
}
