import type { ComponentProps, ReactElement } from 'react';
import type { Components } from 'streamdown';

import { HoverCard as HoverCardPrimitive } from 'radix-ui';
import { useEffect, useRef } from 'react';

import { cn } from '../lib/utils.ts';
import { FileIcon } from './FileIcon.tsx';

const FALLBACK_FAVICON_HREF =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"%3E%3Ccircle cx="8" cy="8" r="6" stroke="%23737373" stroke-width="1.4"/%3E%3Cpath d="M2.5 8h11M8 2c1.55 1.65 2.35 3.65 2.35 6S9.55 12.35 8 14C6.45 12.35 5.65 10.35 5.65 8S6.45 3.65 8 2Z" stroke="%23737373" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2"/%3E%3C/svg%3E';

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

type InlineLinkProps = ComponentProps<'a'> & {
  contentType?: string;
  disabled?: boolean;
  fileName?: string;
  kind?: 'file' | 'web';
  onActivate?: () => void;
  path?: string;
};

export function InlineLink({
  children,
  className,
  contentType,
  disabled = false,
  fileName,
  href,
  kind = 'web',
  onActivate,
  path,
  ...props
}: InlineLinkProps) {
  const target = path ?? href;
  const action = onActivate !== undefined || disabled;
  const content = (
    <>
      {kind === 'file' ? (
        <FileIcon
          className="size-3.5 shrink-0 self-center"
          contentType={contentType}
          fileName={fileName ?? fileNameFromHref(target)}
        />
      ) : (
        <FaviconIcon href={href} />
      )}
      <span className="min-w-0 border-transparent border-b border-dashed [overflow-wrap:anywhere] group-hover/inline-link:border-current group-focus-visible/inline-link:border-current">
        {children}
      </span>
    </>
  );
  const linkClassName = cn(
    'inline-flex w-fit max-w-full items-baseline gap-1 align-baseline font-[inherit] text-accent-blue leading-[inherit] no-underline hover:no-underline',
    action && 'border-0 bg-transparent p-0',
    !disabled && 'group/inline-link',
    className,
    disabled ? 'cursor-default text-muted-foreground' : 'cursor-pointer'
  );
  const control = action ? (
    <button
      aria-disabled={disabled || undefined}
      className={linkClassName}
      data-inline-link={kind}
      data-preserve-cursor="true"
      disabled={disabled}
      onClick={onActivate}
      type="button"
    >
      {content}
    </button>
  ) : (
    <a
      {...props}
      className={linkClassName}
      data-inline-link={kind}
      data-preserve-cursor="true"
      href={href}
      rel={kind === 'web' ? 'noopener noreferrer' : props.rel}
      target={kind === 'web' ? '_blank' : props.target}
    >
      {content}
    </a>
  );
  return (
    <LinkPathPopover href={target}>
      {disabled ? <span className="inline-flex max-w-full items-baseline align-baseline">{control}</span> : control}
    </LinkPathPopover>
  );
}

function FaviconIcon({ href }: { href: string | undefined }) {
  const iconRef = useRef<HTMLImageElement>(null);
  const favicon = faviconHref(href);
  useEffect(() => {
    const icon = iconRef.current;
    if (!icon) return;
    icon.src = FALLBACK_FAVICON_HREF;
    if (!favicon) return;
    const preload = new Image();
    preload.onload = () => {
      if (iconRef.current === icon) icon.src = favicon;
    };
    preload.src = favicon;
    return () => {
      preload.onload = null;
    };
  }, [favicon]);
  return (
    // biome-ignore lint/performance/noImgElement: Runtime cross-origin favicons cannot use a framework image optimizer.
    <img
      alt=""
      aria-hidden="true"
      className="size-3.5 shrink-0 self-center rounded-[2px]"
      data-inline-favicon="true"
      ref={iconRef}
      src={FALLBACK_FAVICON_HREF}
    />
  );
}

export const inlineLinkMarkdownComponents: Components = {
  a: ({ children, className, href, title }) => (
    <InlineLink
      className={className}
      href={href}
      kind={title === 'monad:file' ? 'file' : 'web'}
    >
      {children}
    </InlineLink>
  )
};
