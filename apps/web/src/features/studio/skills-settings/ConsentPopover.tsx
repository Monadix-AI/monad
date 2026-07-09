import type { ReactNode } from 'react';
import type { SkillPending } from './types';

import { Alert01Icon, LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge, Button } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover';

export function ConsentPopover({
  children,
  id,
  consent,
  installingId,
  onConfirm,
  onCancel
}: {
  children: ReactNode;
  id: string;
  consent: SkillPending | undefined | null;
  installingId: string | null;
  onConfirm: () => Promise<unknown>;
  onCancel: (id: string) => void;
}) {
  const t = useT();
  const isInstalling = installingId === id;
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open && consent) onCancel(id);
      }}
      open={Boolean(consent)}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      {consent ? (
        <PopoverContent
          align="end"
          className="w-72 p-3.5"
          side="top"
        >
          <div className="flex flex-col gap-3 text-xs">
            <div className="flex items-start gap-2">
              <HugeiconsIcon
                className="mt-0.5 size-4 shrink-0 text-warning"
                icon={Alert01Icon}
              />
              <div className="min-w-0">
                <div className="font-medium text-sm leading-5">{t('web.skills.consentTitle')}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {consent.skills.map((s) => (
                    <Badge
                      className="text-[10px]"
                      key={s}
                      variant="outline"
                    >
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            {consent.warnings.length > 0 ? (
              <div className="flex flex-col gap-1.5 border-border/70 border-t pt-3">
                <span className="flex items-center gap-1 font-medium text-warning">
                  <HugeiconsIcon
                    className="size-3"
                    icon={Alert01Icon}
                  />
                  {t('web.skills.warningsTitle')}
                </span>
                {consent.warnings.map((w) => (
                  <span
                    className="text-muted-foreground leading-5"
                    key={w}
                  >
                    {w}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => onCancel(id)}
                size="sm"
                variant="ghost"
              >
                {t('web.cancel')}
              </Button>
              <Button
                disabled={isInstalling}
                onClick={() => void onConfirm()}
                size="sm"
              >
                {isInstalling ? (
                  <HugeiconsIcon
                    className="size-3.5 animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                ) : null}
                {t('web.skills.consentConfirm')}
              </Button>
            </div>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
