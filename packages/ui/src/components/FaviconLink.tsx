import type { ComponentProps } from 'react';
import type { Components } from 'streamdown';

import { cn } from '../lib/utils.ts';

export function faviconHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return new URL('/favicon.ico', url.origin).href;
  } catch {
    return undefined;
  }
}

export function hideFailedFavicon(target: Pick<HTMLImageElement, 'hidden'>): void {
  target.hidden = true;
}

export function FaviconLink({ children, className, href, ...props }: ComponentProps<'a'>) {
  const favicon = faviconHref(href);
  return (
    <a
      {...props}
      className={cn('inline-flex max-w-full cursor-pointer items-center gap-1 align-middle', className)}
      data-preserve-cursor="true"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {favicon ? (
        // biome-ignore lint/performance/noImgElement: Runtime cross-origin favicons cannot use a framework image optimizer.
        <img
          alt=""
          aria-hidden="true"
          className="size-3.5 shrink-0 rounded-[2px]"
          onError={(event) => hideFailedFavicon(event.currentTarget)}
          src={favicon}
        />
      ) : null}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </a>
  );
}

export const faviconMarkdownComponents: Components = {
  a: ({ children, className, href }) => (
    <FaviconLink
      className={className}
      href={href}
    >
      {children}
    </FaviconLink>
  )
};
