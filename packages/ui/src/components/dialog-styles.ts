export const dialogSurfaceClassName =
  'glass-surface data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex max-h-[min(42rem,calc(100dvh-2rem))] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col gap-0 overflow-hidden rounded-2xl p-0 outline-none duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in';

export const dialogHeaderClassName = 'flex shrink-0 flex-col gap-2 px-6 pt-6 pb-3 text-left';

export const dialogBodyClassName = 'min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-3 text-sm leading-6';

export const dialogFooterClassName =
  'flex shrink-0 flex-col-reverse gap-2.5 px-6 pt-4 pb-6 sm:flex-row sm:justify-end [&_button]:h-[44px] [&_button]:min-w-[80px] [&_button]:px-4 sm:[&_button]:h-[36px]';

export const dialogTitleClassName = 'text-balance font-semibold text-xl leading-tight tracking-[-0.02em]';

export const dialogDescriptionClassName = 'max-w-[70ch] text-[15px] text-muted-foreground leading-6';
