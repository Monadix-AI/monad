import type { ComponentProps, ReactElement } from 'react';

import { Refresh01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

import { useT } from './I18nProvider';

export type RefreshButtonProps = Omit<ComponentProps<typeof Button>, 'children'> & {
  iconOnly?: boolean;
  label?: string;
  loading: boolean;
};

type RefreshButtonViewProps = Omit<RefreshButtonProps, 'label'> & {
  label: string;
};

export function RefreshButton({ label, ...props }: RefreshButtonProps) {
  const t = useT();
  return (
    <RefreshButtonView
      {...props}
      label={resolveRefreshButtonLabel(label, t)}
    />
  );
}

export function resolveRefreshButtonLabel(
  label: string | undefined,
  translate: (key: 'web.refresh') => string
): string {
  return label ?? translate('web.refresh');
}

export function RefreshButtonView({
  'aria-label': ariaLabel,
  disabled,
  iconOnly = false,
  label,
  loading,
  size,
  type = 'button',
  variant = 'ghost',
  ...props
}: RefreshButtonViewProps): ReactElement<ComponentProps<typeof Button>> {
  return (
    <Button
      {...props}
      aria-label={iconOnly ? (ariaLabel ?? label) : ariaLabel}
      disabled={disabled || loading}
      size={size ?? (iconOnly ? 'icon' : 'sm')}
      type={type}
      variant={variant}
    >
      <HugeiconsIcon
        aria-hidden="true"
        className={loading ? 'animate-spin motion-reduce:animate-none' : undefined}
        icon={Refresh01Icon}
      />
      {iconOnly ? null : label}
    </Button>
  );
}
