import type { McpServerView, McpServerWrite } from '@monad/protocol';

import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog';
import { ServerForm } from './server-form';

export function McpServerDialog({
  nameLocked,
  onOpenChange,
  onSubmit,
  open,
  server
}: {
  nameLocked?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (server: McpServerWrite) => Promise<void>;
  open: boolean;
  server?: McpServerView;
}) {
  const t = useT();
  const [error, setError] = useState<string>();
  const submitServer = async (next: McpServerWrite) => {
    setError(undefined);
    try {
      await onSubmit(next);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) setError(undefined);
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent
        className="max-h-[86dvh]"
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>
            {nameLocked && server ? t('web.mcp.editTitle', { name: server.name }) : t('web.mcp.addTitle')}
          </DialogTitle>
          <DialogDescription>{t('web.mcp.dialogHint')}</DialogDescription>
        </DialogHeader>
        <ServerForm
          error={error}
          key={`${server?.name ?? 'new'}:${server?.transport ?? 'stdio'}`}
          nameLocked={nameLocked}
          onCancel={() => onOpenChange(false)}
          onSubmit={submitServer}
          server={server}
          submitLabel={nameLocked ? t('web.common.save') : t('web.mcp.create')}
          variant="dialog"
        />
      </DialogContent>
    </Dialog>
  );
}
