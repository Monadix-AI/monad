import type { Components } from 'streamdown';
import type { MarkdownProps } from './Markdown.tsx';

import { cn } from '../lib/utils.ts';
import { MarkdownSurface } from './MarkdownSurface.tsx';

const MARKDOWN_CLASSES = [
  'text-sm leading-6 text-foreground',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h1]:mb-3 [&_h1]:mt-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:tracking-normal',
  '[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:tracking-normal',
  '[&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:font-semibold [&_h3]:text-sm [&_h3]:tracking-normal',
  '[&_h4]:mb-1.5 [&_h4]:mt-3 [&_h4]:font-medium [&_h4]:text-sm',
  '[&_ul]:my-2 [&_ol]:my-2 [&_ul]:pl-5 [&_ol]:pl-5',
  '[&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-1 [&_li>p]:my-1',
  '[&_a]:text-link [&_a]:underline-offset-4 hover:[&_a]:underline',
  '[&_strong]:font-semibold [&_em]:text-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]',
  '[&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/35 [&_pre]:p-3 [&_pre]:text-xs',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
  '[&_hr]:my-4 [&_hr]:border-border',
  '[&_img:not([data-inline-favicon])]:my-3 [&_img:not([data-inline-favicon])]:max-h-[42vh] [&_img:not([data-inline-favicon])]:max-w-full [&_img:not([data-inline-favicon])]:rounded-md [&_img:not([data-inline-favicon])]:border [&_img:not([data-inline-favicon])]:object-contain'
];

const MARKDOWN_VARIANTS = {
  compact: [
    'text-[13px] leading-5',
    '[&_h1]:text-base [&_h1]:mb-2',
    '[&_h2]:text-sm [&_h2]:mb-1.5 [&_h2]:mt-3',
    '[&_h3]:text-sm [&_h3]:mb-1 [&_h3]:mt-2.5',
    '[&_pre]:my-2 [&_pre]:p-2.5'
  ],
  default: []
} satisfies Record<string, string[]>;

export type { Components };

export function MarkdownRenderer({ text, className, variant = 'default', streaming, components }: MarkdownProps) {
  return (
    <MarkdownSurface
      className={cn(MARKDOWN_CLASSES, MARKDOWN_VARIANTS[variant], className)}
      components={components}
      isAnimating={streaming}
      mode={streaming ? 'streaming' : 'static'}
    >
      {text}
    </MarkdownSurface>
  );
}
