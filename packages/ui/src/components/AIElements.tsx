import type { MotionProps } from 'motion/react';
import type { ComponentProps, CSSProperties, ElementType, HTMLAttributes, JSX, ReactNode } from 'react';

import {
  BrainIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Clock01Icon,
  Copy01Icon,
  ReloadIcon,
  Wrench01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useControllableState } from '@radix-ui/react-use-controllable-state';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { motion } from 'motion/react';
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
import * as React from 'react';
import { isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';

import { cn } from '../lib/utils';
import { Badge } from './Badge';
import { Button } from './Button';
import { CodeBlock } from './CodeBlock';
import { MorphChevron } from './MorphChevron';
import { Tooltip, TooltipContent, TooltipTrigger } from './Tooltip';

type MotionHTMLProps = MotionProps & Record<string, unknown>;
type MessageRole = 'system' | 'user' | 'assistant' | 'data';
type ToolState =
  | 'approval-requested'
  | 'approval-responded'
  | 'input-available'
  | 'input-streaming'
  | 'output-available'
  | 'output-denied'
  | 'output-error';

const streamdownPlugins = { cjk, code, math, mermaid };

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      {...props}
    />
  );
}

function CollapsibleTrigger({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

function CollapsibleContent({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  );
}

const motionComponentCache = new Map<keyof JSX.IntrinsicElements, React.ComponentType<MotionHTMLProps>>();

function getMotionComponent(element: keyof JSX.IntrinsicElements) {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
}

export interface ShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({ children, as: Component = 'p', className, duration = 2, spread = 2 }: ShimmerProps) => {
  const MotionComponent = getMotionComponent(Component as keyof JSX.IntrinsicElements);
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  return (
    <MotionComponent
      animate={{ backgroundPosition: '0% center' }}
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
        '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
        className
      )}
      initial={{ backgroundPosition: '100% center' }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage: 'var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))'
        } as CSSProperties
      }
      transition={{
        duration,
        ease: 'linear',
        repeat: Number.POSITIVE_INFINITY
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full max-w-[95%] flex-col gap-2',
      from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm',
      'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground',
      'group-[.is-assistant]:text-foreground',
      className
    )}
    data-selectable="true"
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<'div'>;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div
    className={cn('flex items-center gap-1', className)}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = 'ghost',
  size = 'icon-sm',
  ...props
}: MessageActionProps) => {
  const button = (
    <Button
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children && nextProps.isAnimating === prevProps.isAnimating
);

MessageResponse.displayName = 'MessageResponse';

export type ReasoningLabels = {
  thinking?: string;
  thoughtFew?: string;
  thoughtSeconds?: (seconds: number) => string;
};

const defaultReasoningLabels: Required<ReasoningLabels> = {
  thinking: 'Thinking...',
  thoughtFew: 'Thought for a few seconds',
  thoughtSeconds: (seconds) => `Thought for ${seconds} seconds`
};

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = React.createContext<ReasoningContextValue | null>(null);

function useReasoning() {
  const context = React.useContext(ReasoningContext);
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning');
  }
  return context;
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = defaultOpen ?? isStreaming;
    const isExplicitlyClosed = defaultOpen === false;

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp
    });

    const hasEverStreamedRef = useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const startTimeRef = useRef<number | null>(null);

    useEffect(() => {
      if (isStreaming) {
        hasEverStreamedRef.current = true;
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming, setDuration]);

    useEffect(() => {
      if (isStreaming && !isOpen && !isExplicitlyClosed) {
        setIsOpen(true);
      }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

    useEffect(() => {
      if (hasEverStreamedRef.current && !isStreaming && isOpen && !hasAutoClosed) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen);
      },
      [setIsOpen]
    );

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen }),
      [duration, isOpen, isStreaming, setIsOpen]
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn('not-prose mb-4', className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  labels?: ReasoningLabels;
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

function defaultThinkingMessage(labels: ReasoningLabels | undefined, isStreaming: boolean, duration?: number) {
  const resolved = { ...defaultReasoningLabels, ...labels };
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>{resolved.thinking}</Shimmer>;
  }
  if (duration === undefined) {
    return <p>{resolved.thoughtFew}</p>;
  }
  return <p>{resolved.thoughtSeconds(duration)}</p>;
}

export const ReasoningTrigger = memo(
  ({ className, children, labels, getThinkingMessage, ...props }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground',
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <HugeiconsIcon
              className="size-4"
              icon={BrainIcon}
            />
            {getThinkingMessage
              ? getThinkingMessage(isStreaming, duration)
              : defaultThinkingMessage(labels, isStreaming, duration)}
            <MorphChevron
              className="size-4"
              expanded={isOpen}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
};

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => (
  <CollapsibleContent
    className={cn(
      'mt-4 text-sm',
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className
    )}
    {...props}
  >
    <Streamdown plugins={streamdownPlugins}>{children}</Streamdown>
  </CollapsibleContent>
));

Reasoning.displayName = 'Reasoning';
ReasoningTrigger.displayName = 'ReasoningTrigger';
ReasoningContent.displayName = 'ReasoningContent';

export type ToolPart = {
  type: `tool-${string}` | 'dynamic-tool';
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type ToolProps = ComponentProps<typeof Collapsible>;

interface ToolContextValue {
  isOpen: boolean;
}

const ToolContext = React.createContext<ToolContextValue | null>(null);

function useTool() {
  const context = React.useContext(ToolContext);
  if (!context) throw new Error('Tool components must be used within Tool');
  return context;
}

export const Tool = ({ className, defaultOpen, onOpenChange, open, ...props }: ToolProps) => {
  const [isOpen, setIsOpen] = useControllableState<boolean>({
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
    prop: open
  });

  return (
    <ToolContext.Provider value={{ isOpen }}>
      <Collapsible
        className={cn('group/tool not-prose mb-4 w-full rounded-md border', className)}
        onOpenChange={setIsOpen}
        open={isOpen}
        {...props}
      />
    </ToolContext.Provider>
  );
};

export type ToolStatusLabels = Partial<Record<ToolState, string>>;

export const defaultToolStatusLabels: Record<ToolState, string> = {
  'approval-requested': 'Awaiting Approval',
  'approval-responded': 'Responded',
  'input-available': 'Running',
  'input-streaming': 'Pending',
  'output-available': 'Completed',
  'output-denied': 'Denied',
  'output-error': 'Error'
};

export type ToolHeaderProps = {
  'aria-label'?: string;
  title?: string;
  className?: string;
  type: ToolPart['type'];
  state: ToolPart['state'];
  toolName?: string;
  statusLabels?: ToolStatusLabels;
  showStatus?: boolean;
  icon?: ComponentProps<typeof HugeiconsIcon>['icon'];
};

const statusIcons: Record<ToolState, ReactNode> = {
  'approval-requested': (
    <HugeiconsIcon
      className="size-4 text-warning"
      icon={Clock01Icon}
    />
  ),
  'approval-responded': (
    <HugeiconsIcon
      className="size-4 text-info"
      icon={CheckmarkCircle02Icon}
    />
  ),
  'input-available': (
    <HugeiconsIcon
      className="size-4 animate-pulse"
      icon={Clock01Icon}
    />
  ),
  'input-streaming': (
    <HugeiconsIcon
      className="size-4"
      icon={CircleIcon}
    />
  ),
  'output-available': (
    <HugeiconsIcon
      className="size-4 text-success"
      icon={CheckmarkCircle02Icon}
    />
  ),
  'output-denied': (
    <HugeiconsIcon
      className="size-4 text-warning"
      icon={CancelCircleIcon}
    />
  ),
  'output-error': (
    <HugeiconsIcon
      className="size-4 text-destructive"
      icon={CancelCircleIcon}
    />
  )
};

function getStatusBadge(status: ToolState, labels?: ToolStatusLabels) {
  return (
    <Badge
      className="gap-1.5 rounded-full text-xs"
      variant="secondary"
    >
      {statusIcons[status]}
      {labels?.[status] ?? defaultToolStatusLabels[status]}
    </Badge>
  );
}

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  statusLabels,
  showStatus = true,
  icon = Wrench01Icon,
  ...props
}: ToolHeaderProps) => {
  const derivedName = type === 'dynamic-tool' ? toolName : type.split('-').slice(1).join('-');
  const { isOpen } = useTool();

  return (
    <CollapsibleTrigger
      className={cn('group/trigger flex w-full items-center justify-between gap-4 p-3', className)}
      {...props}
    >
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          className="size-4 text-muted-foreground"
          icon={icon}
        />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        {showStatus ? getStatusBadge(state, statusLabels) : null}
      </div>
      <MorphChevron
        className="size-4 text-current"
        expanded={isOpen}
      />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 flex flex-col gap-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolPart['input'];
  label?: string;
};

export const ToolInput = ({ className, input, label = 'Parameters', ...props }: ToolInputProps) => (
  <div
    className={cn('flex flex-col gap-2 overflow-hidden', className)}
    {...props}
  >
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{label}</h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock
        code={JSON.stringify(input, null, 2)}
        language="json"
      />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolPart['output'];
  errorText: ToolPart['errorText'];
  errorLabel?: string;
  resultLabel?: string;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  errorLabel = 'Error',
  resultLabel = 'Result',
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === 'object' && !isValidElement(output)) {
    Output = (
      <CodeBlock
        code={JSON.stringify(output, null, 2)}
        language="json"
      />
    );
  } else if (typeof output === 'string') {
    Output = (
      <CodeBlock
        code={output}
        language="json"
      />
    );
  }

  return (
    <div
      className={cn('flex flex-col gap-2', className)}
      {...props}
    >
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? errorLabel : resultLabel}
      </h4>
      <div
        className={cn(
          'overflow-x-auto rounded-md text-xs [&_table]:w-full',
          errorText ? 'bg-transparent text-destructive' : 'bg-muted/50 text-foreground'
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};

export const AiElementIcons = {
  copy: Copy01Icon,
  regenerate: ReloadIcon
};
