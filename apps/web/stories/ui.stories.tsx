import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from '@monad/ui';

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
  title: 'Web/UI',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Panel: Story = {
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
          <div className="grid gap-3 rounded-md border bg-card p-4">
            <div className="font-medium text-sm">Agent activity</div>
            <p className="text-muted-foreground text-sm">
              A compact panel body for work surfaces that need a fixed header and scrollable content.
            </p>
          </div>
        </PanelShellBody>
      </PanelShell>
    </div>
  )
};

export const BreadcrumbPanel: Story = {
  render: () => (
    <div className="h-screen bg-background text-foreground">
      <PanelShellBreadcrumbHeader
        actions={<Button variant="outline">Open</Button>}
        crumbs={[
          { id: 'workspace', label: 'Workspace' },
          { id: 'sessions', label: 'Sessions' },
          { id: 'active', label: 'Active thread' }
        ]}
      />
    </div>
  )
};

export const Overlays: Story = {
  render: () => (
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
  )
};
