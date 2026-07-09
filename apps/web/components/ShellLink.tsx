'use client';

import type { AnchorHTMLAttributes, ReactElement } from 'react';

import Link from 'next/link';

type ShellLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  replace?: boolean;
};

export function ShellLink({ href, replace = false, ...props }: ShellLinkProps): ReactElement {
  return (
    <Link
      {...props}
      href={href}
      replace={replace}
    />
  );
}
