import type { Components } from 'streamdown';

import { lazy, memo, Suspense } from 'react';

const MarkdownRenderer = lazy(() =>
  import('./MarkdownRenderer.tsx').then((module) => ({ default: module.MarkdownRenderer }))
);

export type { Components };

export type MarkdownProps = {
  text: string;
  className?: string;
  variant?: 'compact' | 'default';
  streaming?: boolean;
  components?: Components;
};

export const Markdown = memo(function Markdown(props: MarkdownProps) {
  return (
    <Suspense fallback={<span className={props.className}>{props.text}</span>}>
      <MarkdownRenderer {...props} />
    </Suspense>
  );
});
