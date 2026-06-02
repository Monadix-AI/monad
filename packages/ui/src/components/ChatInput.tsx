import type { HTMLAttributes, ReactElement } from 'react';

import { cn } from '../lib/utils';

type ChatInputChromeProps = HTMLAttributes<HTMLDivElement>;

function ChatInputChrome({ children, className, ...props }: ChatInputChromeProps): ReactElement {
  return (
    <div
      className={cn('chat-input-chrome', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export { ChatInputChrome };
