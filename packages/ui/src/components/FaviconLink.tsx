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
      className={cn(
        'inline-flex max-w-full cursor-pointer items-baseline gap-1 align-baseline leading-[inherit]',
        className
      )}
      data-inline-link="web"
      data-preserve-cursor="true"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <span
        aria-hidden="true"
        className="relative inline-flex size-3.5 shrink-0 items-center justify-center self-center text-muted-foreground"
        data-favicon-fallback="true"
      >
        <svg
          aria-hidden="true"
          className="size-3"
          fill="none"
          viewBox="0 0 16 16"
        >
          <circle
            cx="8"
            cy="8"
            r="6"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M2.5 8h11M8 2c1.55 1.65 2.35 3.65 2.35 6S9.55 12.35 8 14C6.45 12.35 5.65 10.35 5.65 8S6.45 3.65 8 2Z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.2"
          />
        </svg>
        {favicon ? (
          // biome-ignore lint/performance/noImgElement: Runtime cross-origin favicons cannot use a framework image optimizer.
          <img
            alt=""
            className="absolute inset-0 size-full rounded-[2px]"
            data-inline-favicon="true"
            onError={(event) => hideFailedFavicon(event.currentTarget)}
            src={favicon}
          />
        ) : null}
      </span>
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
