'use client';

import type { AnchorHTMLAttributes, ReactElement } from 'react';

import { navigateShellUrl } from '#/hooks/use-shell-location';

type ShellLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  replace?: boolean;
};

export function ShellLink({ href, replace = false, ...props }: ShellLinkProps): ReactElement {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        props.onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        navigateShellUrl(href, replace ? 'replace' : 'push');
      }}
    />
  );
}
