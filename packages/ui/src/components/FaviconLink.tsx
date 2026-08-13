import type { ComponentProps, ReactElement } from 'react';
import type { Components } from 'streamdown';

import { HoverCard as HoverCardPrimitive } from 'radix-ui';

import { cn } from '../lib/utils.ts';
import { FileIcon } from './FileIcon.tsx';

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

export function fileNameFromHref(href: string | undefined): string {
  if (!href) return 'file';
  const target = href.split('#', 1)[0] || href;
  let path = target;
  try {
    const url = new URL(target);
    path = url.pathname;
  } catch {
    path = target;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    path = target;
  }
  return path.split(/[\\/]/).pop() || 'file';
}

export function filePathFromHref(href: string | undefined): string {
  if (!href) return '';
  let path = href;
  try {
    const url = new URL(href);
    if (url.protocol === 'file:') path = `${url.host ? `//${url.host}` : ''}${url.pathname}${url.search}${url.hash}`;
  } catch {
    path = href;
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function LinkPathPopover({ children, href }: { children: ReactElement; href: string | undefined }) {
  const path = filePathFromHref(href);
  if (!path) return children;
  return (
    <HoverCardPrimitive.Root
      closeDelay={100}
      openDelay={200}
    >
      <HoverCardPrimitive.Trigger asChild>{children}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          align="start"
          className="popup-surface fade-in-0 zoom-in-95 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-w-[min(24em,calc(100vw-2rem))] origin-(--radix-hover-card-content-transform-origin) animate-in rounded-md px-3 py-2 font-mono text-popover-foreground text-xs leading-relaxed outline-hidden [overflow-wrap:anywhere] data-[state=closed]:animate-out"
          side="top"
          sideOffset={6}
        >
          {path}
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}

function FileLink({ children, className, href }: ComponentProps<'a'>) {
  return (
    <LinkPathPopover href={href}>
      <a
        className={cn(
          'inline-flex max-w-full cursor-pointer items-baseline gap-1 align-baseline leading-[inherit] hover:underline hover:decoration-1 hover:decoration-solid hover:underline-offset-2',
          className
        )}
        data-inline-link="file"
        data-preserve-cursor="true"
        href={href}
      >
        <FileIcon
          className="size-3.5 shrink-0 self-center"
          fileName={fileNameFromHref(href)}
        />
        <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      </a>
    </LinkPathPopover>
  );
}

export function FaviconLink({ children, className, href, ...props }: ComponentProps<'a'>) {
  const favicon = faviconHref(href);
  return (
    <LinkPathPopover href={href}>
      <a
        {...props}
        className={cn(
          'inline-flex max-w-full cursor-pointer items-baseline gap-1 align-baseline leading-[inherit] hover:underline hover:decoration-1 hover:decoration-solid hover:underline-offset-2',
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
    </LinkPathPopover>
  );
}

export const faviconMarkdownComponents: Components = {
  a: ({ children, className, href, title }) =>
    title === 'monad:file' ? (
      <FileLink
        className={className}
        href={href}
      >
        {children}
      </FileLink>
    ) : (
      <FaviconLink
        className={className}
        href={href}
      >
        {children}
      </FaviconLink>
    )
};
