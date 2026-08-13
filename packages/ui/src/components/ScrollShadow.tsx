import type { CSSProperties, HTMLAttributes, UIEvent } from 'react';

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '../lib/utils.ts';

export type ScrollShadowVisibility = 'both' | 'bottom' | 'none' | 'top';

export function scrollShadowVisibility({
  clientHeight,
  scrollHeight,
  scrollTop
}: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): ScrollShadowVisibility {
  const top = scrollTop > 1;
  const bottom = scrollTop + clientHeight < scrollHeight - 1;
  if (top && bottom) return 'both';
  if (top) return 'top';
  if (bottom) return 'bottom';
  return 'none';
}

export type ScrollShadowProps = HTMLAttributes<HTMLDivElement> & {
  size?: number;
};

export const ScrollShadow = forwardRef<HTMLDivElement, ScrollShadowProps>(
  ({ children, className, onScroll, size = 16, style, ...props }, forwardedRef) => {
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const [visibility, setVisibility] = useState<ScrollShadowVisibility>('none');
    const setViewportRef = useCallback(
      (node: HTMLDivElement | null) => {
        viewportRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );
    const updateVisibility = useCallback(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      setVisibility(scrollShadowVisibility(viewport));
    }, []);

    useEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      updateVisibility();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(updateVisibility);
      observer.observe(viewport);
      for (const content of viewport.children) {
        if (content instanceof HTMLElement) observer.observe(content);
      }
      return () => observer.disconnect();
    }, [updateVisibility]);

    const handleScroll = (event: UIEvent<HTMLDivElement>) => {
      updateVisibility();
      onScroll?.(event);
    };
    const maskImage = scrollShadowMask(visibility, size);

    return (
      <div
        className={cn('overflow-auto', className)}
        data-bottom-scroll={visibility === 'bottom' || visibility === 'both' ? '' : undefined}
        data-slot="scroll-shadow"
        data-top-scroll={visibility === 'top' || visibility === 'both' ? '' : undefined}
        onScroll={handleScroll}
        ref={setViewportRef}
        style={{ ...style, maskImage, WebkitMaskImage: maskImage } as CSSProperties}
        {...props}
      >
        {children}
      </div>
    );
  }
);

ScrollShadow.displayName = 'ScrollShadow';

function scrollShadowMask(visibility: ScrollShadowVisibility, size: number): string | undefined {
  if (visibility === 'top') return `linear-gradient(to bottom, transparent, black ${size}px)`;
  if (visibility === 'bottom') return `linear-gradient(to bottom, black calc(100% - ${size}px), transparent)`;
  if (visibility === 'both')
    return `linear-gradient(to bottom, transparent, black ${size}px, black calc(100% - ${size}px), transparent)`;
  return undefined;
}
