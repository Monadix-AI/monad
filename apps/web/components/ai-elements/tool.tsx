'use client';

import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import type { ComponentProps, ReactNode } from 'react';

import {
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  ChevronDownIcon,
  CircleIcon,
  Clock01Icon,
  Wrench01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge, cn } from '@monad/ui';
import { isValidElement } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CodeBlock } from './code-block';

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn('group/tool not-prose mb-4 w-full rounded-md border', className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart['type']; state: ToolUIPart['state']; toolName?: never }
  | {
      type: DynamicToolUIPart['type'];
      state: DynamicToolUIPart['state'];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart['state'], string> = {
  'approval-requested': 'Awaiting Approval',
  'approval-responded': 'Responded',
  'input-available': 'Running',
  'input-streaming': 'Pending',
  'output-available': 'Completed',
  'output-denied': 'Denied',
  'output-error': 'Error'
};

const statusIcons: Record<ToolPart['state'], ReactNode> = {
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

const getStatusBadge = (status: ToolPart['state']) => (
  <Badge
    className="gap-1.5 rounded-full text-xs"
    variant="secondary"
  >
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({ className, title, type, state, toolName, ...props }: ToolHeaderProps) => {
  const derivedName = type === 'dynamic-tool' ? toolName : type.split('-').slice(1).join('-');

  return (
    <CollapsibleTrigger
      className={cn('flex w-full items-center justify-between gap-4 p-3', className)}
      {...props}
    >
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          className="size-4 text-muted-foreground"
          icon={Wrench01Icon}
        />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <HugeiconsIcon
        className="size-4 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-180"
        icon={ChevronDownIcon}
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
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div
    className={cn('flex flex-col gap-2 overflow-hidden', className)}
    {...props}
  >
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Parameters</h4>
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
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
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
        {errorText ? 'Error' : 'Result'}
      </h4>
      <div
        className={cn(
          'overflow-x-auto rounded-md text-xs [&_table]:w-full',
          errorText ? 'bg-destructive/10 text-destructive' : 'bg-muted/50 text-foreground'
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
