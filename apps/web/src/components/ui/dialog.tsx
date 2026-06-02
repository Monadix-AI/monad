import {
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Dialog as UiDialog,
  DialogContent as UiDialogContent,
  DialogFooter as UiDialogFooter
} from '@monad/ui';
import { Dialog as DialogPrimitive } from 'radix-ui';
import * as React from 'react';

import { useT } from '#/components/I18nProvider';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <UiDialog {...props} />;
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof UiDialogContent> & {
  showCloseButton?: boolean;
}) {
  const t = useT();
  return (
    <UiDialogContent
      className={className}
      closeLabel={t('web.close')}
      showCloseButton={showCloseButton}
      {...props}
    >
      {children}
    </UiDialogContent>
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<typeof UiDialogFooter> & {
  showCloseButton?: boolean;
}) {
  const t = useT();
  return (
    <UiDialogFooter
      className={className}
      closeLabel={t('web.close')}
      showCloseButton={showCloseButton}
      {...props}
    >
      {children}
    </UiDialogFooter>
  );
}

export { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle };
