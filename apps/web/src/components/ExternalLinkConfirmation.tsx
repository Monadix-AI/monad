import { Confirm } from '@monad/ui';
import { useCallback, useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';

interface PendingExternalLink {
  resolve: (confirmed: boolean) => void;
  url: string;
}

type RequestExternalLink = (url: string) => Promise<boolean>;

let requestExternalLink: RequestExternalLink | undefined;

export function externalLinkHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function requestExternalLinkOpen(url: string): Promise<boolean> {
  return requestExternalLink?.(url) ?? Promise.resolve(false);
}

export function ExternalLinkConfirmation() {
  const t = useT();
  const [pending, setPending] = useState<PendingExternalLink>();
  const request = useCallback<RequestExternalLink>((url) => {
    const href = externalLinkHref(url);
    if (!href) return Promise.resolve(false);
    return new Promise((resolve) => {
      setPending((current) => {
        current?.resolve(false);
        return { resolve, url: href };
      });
    });
  }, []);

  useEffect(() => {
    requestExternalLink = request;
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[data-inline-link="web"]');
      if (!link) return;
      event.preventDefault();
      void request(link.href);
    };
    document.addEventListener('click', intercept);
    return () => {
      if (requestExternalLink === request) requestExternalLink = undefined;
      document.removeEventListener('click', intercept);
    };
  }, [request]);

  const settle = (confirmed: boolean) => {
    if (!pending) return;
    if (confirmed) window.open(pending.url, '_blank', 'noopener,noreferrer');
    pending.resolve(confirmed);
    setPending(undefined);
  };

  return (
    <Confirm
      cancelLabel={t('web.common.cancel')}
      confirmLabel={t('web.externalLink.open')}
      description={t('web.externalLink.description')}
      onConfirm={() => settle(true)}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      open={pending !== undefined}
      title={t('web.externalLink.title')}
    >
      {pending ? (
        <code
          className="block max-h-28 overflow-auto break-all rounded-md bg-muted px-3 py-2 font-code text-foreground text-xs"
          dir="ltr"
        >
          {pending.url}
        </code>
      ) : null}
    </Confirm>
  );
}
