import { LinkSquare01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { ShellLink } from '#/components/ShellLink';

export function CredentialHelp() {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={t('web.credentials.helpLabel')}
          className="size-6 rounded-full text-xs"
          size="icon"
          variant="outline"
        >
          ?
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-2 p-3">
        <p>{t('web.credentials.helpText')}</p>
        <ShellLink
          className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
          href="/studio/credentials#how-to-use"
        >
          {t('web.credentials.learnMore')}
          <HugeiconsIcon
            className="size-3"
            icon={LinkSquare01Icon}
          />
        </ShellLink>
      </TooltipContent>
    </Tooltip>
  );
}
