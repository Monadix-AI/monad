import type { Meta, StoryObj } from '@storybook/react-vite';

import { PlusSignIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';

import {
  Badge,
  Button,
  ButtonGroup,
  ButtonGroupText,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ChatInputChrome,
  CodeBlock,
  CodeInline,
  ComposerAskSheet,
  ComposerContextUsageButton,
  ComposerContextUsagePanel,
  ComposerEditor,
  ComposerIconButton,
  ComposerInlineChip,
  ComposerSubmitButton,
  ComposerSurface,
  ComposerVoiceButton,
  ComposerVoiceUnavailableContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  ImageZoom,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
  Label,
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageOutline,
  MessageResponse,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProductIcon,
  Progress,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  ScrollArea,
  ScrollBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Shimmer,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  UnifiedComposer
} from '../src';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  Avatar,
  MiniTag,
  PresenceBadge,
  PresenceDot,
  TagChip
} from '../src/components/AgentAvatar';
import { Markdown } from '../src/components/Markdown';
import { MentionText, mentionToken } from '../src/components/MentionText';
import { VirtualList } from '../src/components/VirtualList';

const meta = {
  title: 'UI/All Components',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const frameClassName = 'min-h-screen bg-background p-8 text-foreground';

const noop = () => {};
const scrollRows = Array.from({ length: 12 }, (_, index) => `Scrollable row ${index + 1}`);

export const CoreControls: Story = {
  render: () => {
    const [enabled, setEnabled] = useState(true);
    return (
      <div className={frameClassName}>
        <div className="grid max-w-4xl gap-6">
          <section className="grid gap-3">
            <h2 className="font-semibold text-lg">Buttons, badges, inputs</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Button>Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <Button size="icon">
                <HugeiconsIcon icon={PlusSignIcon} />
              </Button>
            </div>
            <ButtonGroup>
              <Button variant="outline">Preview</Button>
              <ButtonGroupText>2 selected</ButtonGroupText>
              <Button variant="outline">Apply</Button>
            </ButtonGroup>
            <div className="flex flex-wrap items-center gap-2">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
              <Badge variant="destructive">Alert</Badge>
            </div>
            <Label
              className="grid max-w-sm gap-1.5"
              htmlFor="story-input"
            >
              Workspace name
              <Input
                id="story-input"
                placeholder="Name"
              />
            </Label>
            <Textarea
              className="max-w-sm"
              placeholder="Notes"
            />
            <InputGroup className="max-w-md">
              <InputGroupAddon>
                <HugeiconsIcon icon={Search01Icon} />
              </InputGroupAddon>
              <InputGroupInput placeholder="Search sessions" />
              <InputGroupButton>Search</InputGroupButton>
            </InputGroup>
            <InputGroup className="max-w-md">
              <InputGroupText>Prompt</InputGroupText>
              <InputGroupTextarea placeholder="Describe the task" />
            </InputGroup>
            <div className="flex items-center gap-3">
              <Switch
                aria-label="Enable notifications"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              <span className="text-muted-foreground text-sm">Notifications {enabled ? 'enabled' : 'disabled'}</span>
            </div>
            <Progress
              className="max-w-sm"
              value={64}
            />
          </section>

          <Separator />

          <section className="grid gap-3">
            <h2 className="font-semibold text-lg">Navigation and overlays</h2>
            <Tabs
              className="max-w-xl"
              defaultValue="chat"
            >
              <TabsList>
                <TabsTrigger value="chat">Chat</TabsTrigger>
                <TabsTrigger value="files">Files</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>
              <TabsContent
                className="rounded-md border bg-card p-4"
                value="chat"
              >
                Transcript tools and composer controls.
              </TabsContent>
              <TabsContent
                className="rounded-md border bg-card p-4"
                value="files"
              >
                Generated files and attachments.
              </TabsContent>
              <TabsContent
                className="rounded-md border bg-card p-4"
                value="activity"
              >
                Recent approvals and tool calls.
              </TabsContent>
            </Tabs>
            <div className="flex flex-wrap items-center gap-2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline">Tooltip</Button>
                  </TooltipTrigger>
                  <TooltipContent>Helpful context</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">Popover</Button>
                </PopoverTrigger>
                <PopoverContent>
                  <div className="grid gap-1 text-sm">
                    <strong>Run options</strong>
                    <span className="text-muted-foreground">Pick the execution profile.</span>
                  </div>
                </PopoverContent>
              </Popover>
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Archive session?</DialogTitle>
                    <DialogDescription>This keeps the transcript available.</DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline">Cancel</Button>
                    <Button>Archive</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">Dropdown</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Actions</DropdownMenuLabel>
                  <DropdownMenuGroup>
                    <DropdownMenuItem>
                      Open
                      <DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuCheckboxItem checked>Show archived</DropdownMenuCheckboxItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup value="auto">
                    <DropdownMenuRadioItem value="auto">Auto</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="manual">Manual</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem>Export</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </section>
        </div>
      </div>
    );
  }
};

export const SurfacesAndFeedback: Story = {
  render: () => (
    <div className={frameClassName}>
      <div className="grid max-w-5xl gap-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Session summary</CardTitle>
            <CardDescription>Compact card surface with actions.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge variant="secondary">Active</Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Context</span>
                <span>64%</span>
              </div>
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button variant="outline">Archive</Button>
            <Button>Open</Button>
          </CardFooter>
        </Card>
        <div className="flex flex-wrap items-center gap-4">
          <Spinner className="size-6" />
          <Skeleton className="h-8 w-48" />
          <Shimmer>Thinking through the next step</Shimmer>
        </div>
        <ScrollArea className="h-40 max-w-md rounded-md border">
          <div className="grid gap-2 p-4 text-sm">
            {scrollRows.map((row) => (
              <div key={row}>{row}</div>
            ))}
          </div>
          <ScrollBar />
        </ScrollArea>
        <ImageZoom>
          <svg
            aria-label="Gradient preview"
            className="h-36 w-64 rounded-md object-cover"
            role="img"
            viewBox="0 0 640 360"
          >
            <defs>
              <linearGradient
                id="storybook-gradient"
                x1="0"
                x2="1"
                y1="0"
                y2="1"
              >
                <stop stopColor="#0ea5e9" />
                <stop
                  offset="1"
                  stopColor="#22c55e"
                />
              </linearGradient>
            </defs>
            <rect
              fill="url(#storybook-gradient)"
              height="360"
              width="640"
            />
          </svg>
        </ImageZoom>
      </div>
    </div>
  )
};

export const TextAndCode: Story = {
  render: () => (
    <div className={frameClassName}>
      <div className="grid max-w-4xl gap-6">
        <Markdown
          text={'## Markdown\n\n- Streams **rich** content\n- Supports `inline code`\n\n```ts\nconst ok = true;\n```'}
        />
        <div className="text-sm">
          <MentionText text={`Assigned to ${mentionToken({ name: 'Zeke', id: 'user_1' })} for review.`} />
        </div>
        <div className="flex items-center gap-2">
          <CodeInline
            code="bun dev"
            language="shellscript"
          />
          <CodeInline
            code="const value = 42"
            language="ts"
          />
        </div>
        <CodeBlock
          code={'export function run() {\n  return "storybook";\n}'}
          language="ts"
          showLineNumbers
        />
      </div>
    </div>
  )
};

export const MessagesAndTools: Story = {
  render: () => (
    <div className={frameClassName}>
      <div className="grid max-w-3xl gap-4">
        <Message from="user">
          <MessageContent>Show the active sessions and summarize blockers.</MessageContent>
        </Message>
        <Message from="assistant">
          <MessageContent>
            <MessageResponse>There are **3 active sessions**. One is waiting for approval.</MessageResponse>
          </MessageContent>
          <MessageActions>
            <MessageAction label="Copy">Copy</MessageAction>
            <MessageAction label="Retry">Retry</MessageAction>
          </MessageActions>
        </Message>
        <Reasoning defaultOpen>
          <ReasoningTrigger />
          <ReasoningContent>Checking current route state and pending tool calls.</ReasoningContent>
        </Reasoning>
        <Tool defaultOpen>
          <ToolHeader
            state="output-available"
            type="tool-shell"
          />
          <ToolContent>
            <ToolInput input={{ cmd: 'bun test' }} />
            <ToolOutput
              errorText={undefined}
              output={'36 pass\n0 fail'}
            />
          </ToolContent>
        </Tool>
      </div>
    </div>
  )
};

export const AgentIdentityComponents: Story = {
  render: () => (
    <div className={frameClassName}>
      <div className="grid max-w-xl gap-4">
        <div className="flex items-center gap-3">
          <Avatar
            av="AI"
            icon="codex"
            kind="agent"
          />
          <AgentInstanceAvatar agent={{ icon: 'claude-code', name: 'Claude Code' }} />
          <ProductIcon
            product="gemini"
            size={28}
          />
        </div>
        <AgentIdentity
          badge={<TagChip tag="AI" />}
          name="Codex workspace agent"
        />
        <div className="flex items-center gap-3">
          <PresenceDot presence="working" />
          <PresenceBadge presence="online" />
          <MiniTag tag="BOT" />
        </div>
      </div>
    </div>
  )
};

export const ComposerComponents: Story = {
  render: () => {
    const [value, setValue] = useState('Summarize this workspace and mention @');
    return (
      <div className={frameClassName}>
        <div className="grid max-w-3xl gap-5">
          <ChatInputChrome className="p-3">
            <span className="text-muted-foreground text-sm">Chrome-only wrapper</span>
          </ChatInputChrome>
          <ComposerSurface
            accessoryLeftTools={
              <>
                <ComposerContextUsageButton
                  ariaLabel="Context usage"
                  percent={56}
                  title="56% used"
                  usageAvailable
                />
                <ComposerInlineChip
                  kind="skill"
                  label="repo-search"
                />
              </>
            }
            rightTools={
              <>
                <ComposerVoiceButton
                  ariaLabel="Voice"
                  state="idle"
                />
                <ComposerSubmitButton
                  ariaLabel="Send"
                  canSend
                />
              </>
            }
          >
            <ComposerEditor
              ariaLabel="Message"
              disabled={false}
              mention
              onChange={setValue}
              onSubmit={noop}
              placeholder="Ask anything"
              value={value}
            />
          </ComposerSurface>
          <UnifiedComposer
            controls={{
              attach: <ComposerIconButton ariaLabel="Attach">+</ComposerIconButton>,
              submit: (
                <ComposerSubmitButton
                  ariaLabel="Send"
                  canSend
                />
              )
            }}
            editor={<div className="min-h-12 p-1 text-muted-foreground text-sm">Unified composer editor slot</div>}
          />
          <ComposerContextUsagePanel
            contextUsedLabel="used"
            limit={32_000}
            percent={56}
            segments={[
              {
                category: 'files',
                color: '#0ea5e9',
                label: 'Files',
                tokens: 7200
              },
              {
                category: 'history',
                color: '#22c55e',
                label: 'History',
                tokens: 10_800
              }
            ]}
            used={18_000}
          />
          <ComposerVoiceUnavailableContent
            reason="Microphone access is unavailable in this environment."
            settingsLabel="settings"
            setupPrefix="Open"
            setupSuffix="to configure voice input."
          />
        </div>
      </div>
    );
  }
};

export const AskSheetAndLists: Story = {
  render: () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      id: `item-${index}`,
      text: `Transcript item ${index + 1}`
    }));
    return (
      <div className={frameClassName}>
        <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)_120px] gap-6">
          <div className="grid gap-5">
            <ComposerAskSheet
              askedLabel="Question"
              asker={<Badge variant="secondary">Codex</Badge>}
              buildAnswer={(selected, other) => [...selected, other].filter(Boolean).join(', ') || null}
              dismissLabel="Dismiss"
              onAnswer={noop}
              onDismiss={noop}
              otherAriaLabel="Other answer"
              otherPlaceholder="Other"
              position={1}
              question={{
                allowOther: true,
                id: 'priority',
                mode: 'multiple',
                options: ['Fast', 'Thorough', 'Minimal'],
                question: 'What should this pass optimize for?'
              }}
              submitLabel="Send"
              total={2}
            />
            <div className="h-80 rounded-md border">
              <VirtualList
                getKey={(item) => item.id}
                items={items}
                renderItem={(item) => (
                  <div
                    className="border-b px-3 py-2 text-sm"
                    data-virtual-list-anchor="true"
                  >
                    {item.text}
                  </div>
                )}
              />
            </div>
          </div>
          <MessageOutline
            activeIds={new Set(['setup', 'verify'])}
            ariaLabel="Transcript outline"
            goToLabel={(item) => `Go to ${item.label}`}
            items={['Setup', 'Build', 'Review', 'Fixes', 'Verify', 'Done'].map((label, index) => ({
              id: label.toLowerCase(),
              index: index * 8,
              label,
              time: `10:${String(index).padStart(2, '0')}`
            }))}
            onSelect={noop}
            renderPreview={(item) => item.label}
          />
        </div>
      </div>
    );
  }
};

export const Selectors: Story = {
  render: () => (
    <div className={frameClassName}>
      <div className="flex max-w-xl flex-wrap items-center gap-3">
        <Select defaultValue="auto">
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="readonly">Read only</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
};
