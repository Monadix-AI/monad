import type { HookEvent } from '@monad/protocol';
import type { TFn } from '#/components/I18nProvider';
import type { DraftMatcher } from './hook-settings-types';

import { Delete02Icon, PlusSignIcon, ShieldQuestionMarkIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Input, Label } from '@monad/ui';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '#/components/ui/dialog';

type HookEditorDialogProps = {
  event: HookEvent;
  description: string;
  matchers: DraftMatcher[];
  t: TFn;
  matcherError: (pattern: string | undefined) => string | undefined;
  onAddCommand: (event: HookEvent, matcherId: number) => void;
  onAddMatcher: (event: HookEvent) => void;
  onClose: () => void;
  onRemoveCommand: (event: HookEvent, matcherId: number, cmdId: number) => void;
  onRemoveMatcher: (event: HookEvent, id: number) => void;
  onToggleFailClosed: (event: HookEvent, matcherId: number, cmdId: number) => void;
  onUpdateCommand: (
    event: HookEvent,
    matcherId: number,
    cmdId: number,
    field: 'command' | 'timeoutMs',
    value: string
  ) => void;
  onUpdateMatcherFilter: (event: HookEvent, id: number, value: string) => void;
};

export function HookEditorDialog({
  event,
  description,
  matchers,
  t,
  matcherError,
  onAddCommand,
  onAddMatcher,
  onClose,
  onRemoveCommand,
  onRemoveMatcher,
  onToggleFailClosed,
  onUpdateCommand,
  onUpdateMatcherFilter
}: HookEditorDialogProps) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent
        className="max-h-[min(760px,calc(100dvh-48px))]"
        size="xl"
      >
        <DialogHeader>
          <DialogTitle className="font-semibold text-base leading-5">{event}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-5">
            {matchers.map((matcher) => {
              const filterErr = matcherError(matcher.matcher);
              return (
                <section
                  className="flex flex-col gap-3 border-border/70 border-b pb-5 last:border-b-0 last:pb-0"
                  key={matcher._id}
                >
                  {(event === 'BeforeTool' || event === 'AfterTool' || event === 'ApprovalRequest') && (
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs">{t('web.hooks.filterLabel')}</Label>
                      <Input
                        aria-invalid={filterErr ? true : undefined}
                        className="h-8 font-code text-xs aria-[invalid=true]:border-destructive"
                        onChange={(e) => onUpdateMatcherFilter(event, matcher._id, e.target.value)}
                        placeholder={t('web.hooks.filterPlaceholder')}
                        value={matcher.matcher ?? ''}
                      />
                      {filterErr && (
                        <p className="text-destructive text-xs">{t('web.hooks.invalidRegex', { error: filterErr })}</p>
                      )}
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    <Label className="text-xs">{t('web.hooks.commandsLabel')}</Label>
                    {matcher.hooks.map((hook) => (
                      <div
                        className="grid grid-cols-[minmax(0,1fr)_6rem_2rem_2rem] items-center gap-2"
                        key={hook._id}
                      >
                        <Input
                          className="h-8 font-code text-xs"
                          onChange={(e) => onUpdateCommand(event, matcher._id, hook._id, 'command', e.target.value)}
                          placeholder={t('web.hooks.commandPlaceholder')}
                          value={hook.command}
                        />
                        <Input
                          className="h-8 font-ui text-xs"
                          min={1}
                          onChange={(e) => onUpdateCommand(event, matcher._id, hook._id, 'timeoutMs', e.target.value)}
                          placeholder={t('web.hooks.timeoutPlaceholder')}
                          title={t('web.hooks.timeoutTitle')}
                          type="number"
                          value={hook.timeoutMs ?? ''}
                        />
                        <Button
                          aria-label={t('web.hooks.failClosedTitle')}
                          aria-pressed={hook.onError === 'deny'}
                          className="size-8 aria-[pressed=true]:text-destructive"
                          onClick={() => onToggleFailClosed(event, matcher._id, hook._id)}
                          size="icon"
                          title={t('web.hooks.failClosedTitle')}
                          variant="ghost"
                        >
                          <HugeiconsIcon
                            className="size-3.5"
                            icon={ShieldQuestionMarkIcon}
                          />
                        </Button>
                        <Button
                          aria-label={t('web.hooks.deleteCommand')}
                          className="size-8"
                          onClick={() => onRemoveCommand(event, matcher._id, hook._id)}
                          size="icon"
                          variant="ghost"
                        >
                          <HugeiconsIcon
                            className="size-3.5 text-destructive"
                            icon={Delete02Icon}
                          />
                        </Button>
                      </div>
                    ))}
                    <Button
                      className="h-7 w-fit gap-1 text-xs"
                      onClick={() => onAddCommand(event, matcher._id)}
                      size="sm"
                      variant="ghost"
                    >
                      <HugeiconsIcon
                        className="size-3"
                        icon={PlusSignIcon}
                      />
                      {t('web.hooks.addCommand')}
                    </Button>
                  </div>

                  <div className="flex justify-end">
                    <Button
                      className="h-7 gap-1 text-destructive text-xs"
                      onClick={() => onRemoveMatcher(event, matcher._id)}
                      size="sm"
                      variant="ghost"
                    >
                      <HugeiconsIcon
                        className="size-3"
                        icon={Delete02Icon}
                      />
                      {t('web.hooks.removeMatcher')}
                    </Button>
                  </div>
                </section>
              );
            })}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            className="h-8 gap-1 text-xs"
            onClick={() => onAddMatcher(event)}
            size="sm"
            variant="outline"
          >
            <HugeiconsIcon
              className="size-3"
              icon={PlusSignIcon}
            />
            {t('web.hooks.addHook')}
          </Button>
          <Button
            onClick={onClose}
            size="sm"
          >
            {t('web.common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
