'use client';

import type { AnchorHTMLAttributes, MouseEvent, ReactElement } from 'react';

import { pushShellUrl, replaceShellUrl } from '#/hooks/use-shell-location';

type ShellLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  replace?: boolean;
};

function shouldUseBrowserNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
  );
}

export function ShellLink({ href, onClick, replace = false, target, ...props }: ShellLinkProps): ReactElement {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (!href || target || shouldUseBrowserNavigation(event)) return;
        const nextUrl = new URL(href, window.location.href);
        if (nextUrl.origin !== window.location.origin) return;
        event.preventDefault();
        if (replace) replaceShellUrl(href);
        else pushShellUrl(href);
      }}
      target={target}
    />
  );
}
