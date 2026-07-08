'use client';

import type { CSSProperties } from 'react';

import { cn } from '@monad/ui';

interface MonadLoadingProps {
  className?: string;
  label?: string;
  markClassName?: string;
}

const iconMaskStyle: CSSProperties = {
  WebkitMaskImage: 'url("/monad-icon-vector-solid.svg")',
  maskImage: 'url("/monad-icon-vector-solid.svg")',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
  maskPosition: 'center',
  WebkitMaskSize: 'contain',
  maskSize: 'contain'
};

export function MonadLoading({ className, label = 'Loading', markClassName }: MonadLoadingProps) {
  return (
    <div
      aria-label={label}
      className={cn('monad-loading flex items-center justify-center', className)}
      role="status"
    >
      <div
        aria-hidden="true"
        className={cn('monad-loading-mark', markClassName)}
        style={iconMaskStyle}
      >
        <span className="monad-loading-glass" />
        <span className="monad-loading-sheen" />
      </div>
    </div>
  );
}
