import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button, TooltipProvider } from '@monad/ui';
import { useEffect, useState } from 'react';

import { DestructiveConfirmPopover } from '#/components/DestructiveConfirmPopover';
import { HoverActions, ProfileCardHoverActions } from '#/components/HoverActions';
import { I18nProvider, I18nTrans, useT } from '#/components/I18nProvider';
import { MonadLoading } from '#/components/MonadLoading';
import { MonadIcon, MonadLogo } from '#/components/MonadLogo';
import { PanelLoading } from '#/components/PanelLoading';
import { ReasoningEffortControl, reasoningEffortOption } from '#/components/ReasoningEffortControl';
import { ThemeToggle } from '#/components/ThemeToggle';
import { ToastProvider, toast } from '#/components/ToastProvider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '#/components/ui/dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#/components/ui/hover-card';
import { PanelShell, PanelShellBody, PanelShellBreadcrumbHeader, PanelShellHeader } from '#/components/ui/panel-shell';
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover';

const meta = {
  title: 'Web/All Components',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const frameClassName = 'min-h-screen bg-background p-8 text-foreground';

function ToastDemo() {
  useEffect(() => {
    toast.success('Storybook toast ready', {
      detail: { source: 'storybook', status: 'ok' },
      duration: 8000
    });
    toast.undo('Archived session', {
      action: {
        label: 'Undo',
        onClick: () => true
      },
      duration: 8000
    });
  }, []);

  return (
    <div className="flex gap-2">
      <Button onClick={() => toast.info('Information toast')}>Info toast</Button>
      <Button onClick={() => toast.error('Error toast', { detail: { code: 'E_STORY' } })}>Error toast</Button>
    </div>
  );
}

function TranslationPreview() {
  const t = useT();
  return (
    <div className="grid gap-2 rounded-md border bg-card p-4 text-sm">
      <div>{t('web.cancel')}</div>
      <I18nTrans
        components={{ strong: <strong /> }}
        i18nKey={'web.cancel' as never}
      />
    </div>
  );
}

export const BrandAndLoading: Story = {
  render: () => (
    <div className={frameClassName}>
      <div className="grid max-w-xl gap-6">
        <div className="flex items-center gap-4">
          <MonadLogo />
          <MonadIcon className="size-8" />
        </div>
        <MonadLoading label="Loading workspace" />
        <PanelLoading />
      </div>
    </div>
  )
};

export const ShellAndPanels: Story = {
  render: () => (
    <div className="h-screen bg-background text-foreground">
      <PanelShell>
        <PanelShellHeader
          actions={
            <>
              <Button variant="outline">Share</Button>
              <Button>Run</Button>
            </>
          }
          badge={<span className="rounded-full bg-info/15 px-2 py-0.5 text-info text-xs">Live</span>}
          subtitle="3 active tasks"
          title="Workspace"
        />
        <PanelShellBody className="p-4">
          <div className="grid gap-4">
            <PanelShellBreadcrumbHeader
              actions={<Button variant="outline">Open</Button>}
              crumbs={[
                { id: 'workspace', label: 'Workspace' },
                { id: 'sessions', label: 'Sessions' },
                { id: 'active', label: 'Active thread' }
              ]}
            />
            <div className="rounded-md border bg-card p-4">
              <div className="font-medium text-sm">Panel body</div>
              <p className="mt-1 text-muted-foreground text-sm">Fixed header plus scrollable workspace content.</p>
            </div>
          </div>
        </PanelShellBody>
      </PanelShell>
    </div>
  )
};

export const WebOverlays: Story = {
  render: () => (
    <TooltipProvider>
      <div className="flex min-h-screen items-center justify-center gap-3 bg-background text-foreground">
        <Dialog defaultOpen>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm handoff</DialogTitle>
              <DialogDescription>Move this thread to another workspace owner.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline">Cancel</Button>
              <Button>Confirm</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Popover defaultOpen>
          <PopoverTrigger asChild>
            <Button variant="outline">Popover</Button>
          </PopoverTrigger>
          <PopoverContent>
            <div className="grid gap-1">
              <div className="font-medium text-sm">Run options</div>
              <p className="text-muted-foreground text-sm">Choose a model profile before starting the task.</p>
            </div>
          </PopoverContent>
        </Popover>
        <HoverCard defaultOpen>
          <HoverCardTrigger asChild>
            <Button variant="ghost">Hover card</Button>
          </HoverCardTrigger>
          <HoverCardContent>
            <div className="grid gap-1">
              <div className="font-medium text-sm">Session owner</div>
              <p className="text-muted-foreground text-sm">Shows contextual metadata without changing selection.</p>
            </div>
          </HoverCardContent>
        </HoverCard>
      </div>
    </TooltipProvider>
  )
};

export const WebActions: Story = {
  render: () => {
    const [effort, setEffort] = useState<string | undefined>('medium');
    return (
      <TooltipProvider>
        <div className={frameClassName}>
          <div className="grid max-w-xl gap-6">
            <div className="relative rounded-md border bg-card p-4">
              <div className="font-medium text-sm">Hover action row</div>
              <p className="text-muted-foreground text-sm">Actions fade in over dense workspace rows.</p>
              <HoverActions>
                <Button size="sm">Open</Button>
              </HoverActions>
              <ProfileCardHoverActions>
                <Button size="sm">Profile</Button>
              </ProfileCardHoverActions>
            </div>
            <DestructiveConfirmPopover
              confirmLabel="Delete"
              description="Delete this local draft?"
              onConfirm={async () => undefined}
            >
              <Button variant="destructive">Destructive confirm</Button>
            </DestructiveConfirmPopover>
            <ReasoningEffortControl
              onChange={setEffort}
              options={['low', 'medium', 'high'].map(reasoningEffortOption)}
              value={effort}
            />
            <ThemeToggle />
          </div>
        </div>
      </TooltipProvider>
    );
  }
};

export const ProvidersAndToasts: Story = {
  render: () => (
    <I18nProvider>
      <ToastProvider>
        <TooltipProvider>
          <div className={frameClassName}>
            <div className="grid max-w-xl gap-4">
              <TranslationPreview />
              <ToastDemo />
            </div>
          </div>
        </TooltipProvider>
      </ToastProvider>
    </I18nProvider>
  )
};
