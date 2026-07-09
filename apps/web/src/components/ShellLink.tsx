'use client';

import type { AnchorHTMLAttributes, ReactElement } from 'react';

import { Link } from '@tanstack/react-router';

type ShellLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  replace?: boolean;
};

export function ShellLink({ href, replace = false, ...props }: ShellLinkProps): ReactElement {
  return (
    <Link
      {...props}
      replace={replace}
      to={href as never}
    />
  );
}
