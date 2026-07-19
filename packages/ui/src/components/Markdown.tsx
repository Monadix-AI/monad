import type { Components } from 'streamdown';

import { memo } from 'react';

import { MarkdownRenderer } from './MarkdownRenderer.tsx';

export type { Components };

export type MarkdownProps = {
  text: string;
  className?: string;
  variant?: 'compact' | 'default';
  streaming?: boolean;
  components?: Components;
};

export const Markdown = memo(function Markdown(props: MarkdownProps) {
  return <MarkdownRenderer {...props} />;
});
