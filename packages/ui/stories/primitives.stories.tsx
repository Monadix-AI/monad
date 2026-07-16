import type { Meta, StoryObj } from '@storybook/react-vite';

import { useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from '../src';

const meta = {
  title: 'UI/Primitives',
  parameters: {
    layout: 'centered'
  }
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Controls: Story = {
  render: () => {
    const [enabled, setEnabled] = useState(true);

    return (
      <div className="grid w-[520px] gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button
            size="sm"
            variant="destructive"
          >
            Destructive
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Alert</Badge>
        </div>
        <label
          className="grid gap-1.5"
          htmlFor="workspace-name"
        >
          <span className="font-medium text-sm">Workspace name</span>
          <Input
            defaultValue="Monad workspace"
            id="workspace-name"
            placeholder="Name"
          />
        </label>
        <div className="flex items-center gap-3">
          <Switch
            aria-label="Enable background sync"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          <span className="text-muted-foreground text-sm">Background sync {enabled ? 'enabled' : 'disabled'}</span>
        </div>
      </div>
    );
  }
};

export const Surface: Story = {
  render: () => (
    <Card className="w-[420px]">
      <CardHeader>
        <CardTitle>Session summary</CardTitle>
        <CardDescription>Compact state for a running agent session.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status</span>
            <Badge variant="secondary">Active</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Context</span>
            <span>42%</span>
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="outline">Archive</Button>
        <Button>Open</Button>
      </CardFooter>
    </Card>
  )
};

export const Navigation: Story = {
  render: () => (
    <Tabs
      className="w-[460px]"
      defaultValue="chat"
    >
      <TabsList>
        <TabsTrigger value="chat">Chat</TabsTrigger>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent
        className="rounded-md border bg-card p-4 text-sm"
        value="chat"
      >
        Chat transcript controls and summaries.
      </TabsContent>
      <TabsContent
        className="rounded-md border bg-card p-4 text-sm"
        value="files"
      >
        Attached files and generated artifacts.
      </TabsContent>
      <TabsContent
        className="rounded-md border bg-card p-4 text-sm"
        value="activity"
      >
        Recent tools, approvals, and checkpoints.
      </TabsContent>
    </Tabs>
  )
};

export const Modal: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive session?</DialogTitle>
          <DialogDescription>This keeps the transcript available while removing it from active work.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Archive</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
};
