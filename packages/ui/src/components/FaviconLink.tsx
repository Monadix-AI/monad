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
      className={cn(className)}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {favicon ? (
        <img
          alt=""
          aria-hidden="true"
          className="mr-1 inline size-3.5 rounded-[2px] align-[-2px]"
          onError={(event) => hideFailedFavicon(event.currentTarget)}
          src={favicon}
        />
      ) : null}
      {children}
    </a>
  );
}

export const faviconMarkdownComponents = { a: FaviconLink } satisfies Components;
