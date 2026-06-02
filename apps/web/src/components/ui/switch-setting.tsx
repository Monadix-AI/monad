import type { ReactNode } from 'react';

import { cn, Switch } from '@monad/ui';
import { useId } from 'react';

export function SwitchSetting({
  checked,
  className,
  contentClassName,
  controlBefore,
  description,
  descriptionClassName,
  disabled,
  icon,
  id,
  onCheckedChange,
  switchAriaLabel,
  switchClassName,
  title,
  titleClassName
}: {
  checked: boolean;
  className?: string;
  contentClassName?: string;
  controlBefore?: ReactNode;
  description?: ReactNode;
  descriptionClassName?: string;
  disabled?: boolean;
  icon?: ReactNode;
  id?: string;
  onCheckedChange?: (checked: boolean) => void;
  switchAriaLabel?: string;
  switchClassName?: string;
  title: ReactNode;
  titleClassName?: string;
}) {
  const generatedId = useId();
  const titleId = `${id ?? generatedId}-title`;
  const descriptionId = description ? `${id ?? generatedId}-description` : undefined;

  return (
    <div className={cn('flex min-w-0 items-start gap-4', className)}>
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {icon ? (
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground"
          >
            {icon}
          </span>
        ) : null}
        <div className={cn('min-w-0 flex-1', contentClassName)}>
          <div
            className={cn('font-medium text-sm leading-5', titleClassName)}
            id={titleId}
          >
            {title}
          </div>
          {description ? (
            <div
              className={cn('mt-0.5 text-muted-foreground text-xs leading-4', descriptionClassName)}
              id={descriptionId}
            >
              {description}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {controlBefore}
        <Switch
          aria-describedby={descriptionId}
          aria-label={switchAriaLabel}
          aria-labelledby={switchAriaLabel ? undefined : titleId}
          checked={checked}
          className={cn('mt-0.5', switchClassName)}
          disabled={disabled}
          id={id}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </div>
  );
}
