import type { ComponentProps } from 'react';
import type { PluginConfig } from 'streamdown';

import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';

import { cn } from '../lib/utils.ts';

const markdownPlugins: PluginConfig = {
  cjk,
  code: code as PluginConfig['code'],
  math,
  mermaid
};

export type MarkdownSurfaceProps = ComponentProps<typeof Streamdown>;

export function MarkdownSurface({ className, ...props }: MarkdownSurfaceProps) {
  return (
    <Streamdown
      {...props}
      className={cn('monad-markdown-content', className)}
      plugins={markdownPlugins}
    />
  );
}
