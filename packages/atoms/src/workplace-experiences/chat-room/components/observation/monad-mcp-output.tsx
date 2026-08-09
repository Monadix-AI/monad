import type { MonadMcpToolName } from './monad-mcp-projection.ts';

import { CheckmarkSquare02Icon, Clock03Icon, SquareIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';

type MonadMcpOutputProps = {
  body?: string;
  completedLabel: string;
  emptyLabel: string;
  falseLabel: string;
  inProgressLabel: string;
  output: unknown;
  pendingLabel: string;
  planEmptyLabel: string;
  toolName: MonadMcpToolName;
  trueLabel: string;
};

const MAX_OUTPUT_DEPTH = 4;
const MAX_OUTPUT_ENTRIES = 50;
const MAX_OUTPUT_TEXT = 20_000;

export function MonadMcpOutput(props: MonadMcpOutputProps) {
  const output = compactFriendlyOutput(friendlyMonadMcpOutput(props.output));
  const planTodos = monadPlanTodos(props.toolName, output);
  const body = props.body?.trim() ? props.body : undefined;
  const promoteTextBody = props.toolName === 'project_post' || props.toolName === 'project_read';
  return (
    <div
      className="min-w-0"
      data-slot="monad-mcp-output"
    >
      <div
        className="min-w-0"
        data-slot="monad-mcp-output-content"
      >
        {planTodos ? (
          <MonadPlanTodoList
            completedLabel={props.completedLabel}
            emptyLabel={props.planEmptyLabel}
            inProgressLabel={props.inProgressLabel}
            pendingLabel={props.pendingLabel}
            todos={planTodos}
          />
        ) : output === undefined && !body ? (
          <span className="text-muted-foreground">{props.emptyLabel}</span>
        ) : output !== undefined ? (
          <MonadMcpOutputValue
            depth={0}
            emptyLabel={props.emptyLabel}
            falseLabel={props.falseLabel}
            omitTextBody={body !== undefined}
            path="result"
            promoteTextBody={promoteTextBody}
            trueLabel={props.trueLabel}
            value={output}
          />
        ) : null}
        {body ? <MonadMcpBodyText text={body} /> : null}
      </div>
    </div>
  );
}

function compactFriendlyOutput(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    const entries = value.map(compactFriendlyOutput).filter((entry) => entry !== undefined);
    return entries.length > 0 ? entries : undefined;
  }
  const record = recordValue(value);
  if (!record) return value;
  const entries = Object.entries(record).flatMap(([key, entry]) => {
    const compacted = compactFriendlyOutput(entry);
    return compacted === undefined ? [] : [[key, compacted] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function MonadMcpOutputValue({
  depth,
  emptyLabel,
  falseLabel,
  omitTextBody,
  path,
  promoteTextBody,
  trueLabel,
  value
}: {
  depth: number;
  emptyLabel: string;
  falseLabel: string;
  omitTextBody: boolean;
  path: string;
  promoteTextBody: boolean;
  trueLabel: string;
  value: unknown;
}): React.ReactNode {
  if (typeof value === 'boolean') return <span className="text-foreground">{value ? trueLabel : falseLabel}</span>;
  if (typeof value === 'string' || typeof value === 'number')
    return (
      <span className="wrap-anywhere whitespace-pre-wrap text-foreground">{boundedOutputText(String(value))}</span>
    );
  if (depth >= MAX_OUTPUT_DEPTH) return <span className="text-muted-foreground">…</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">{emptyLabel}</span>;
    const occurrences = new Map<string, number>();
    return (
      <div className="divide-y divide-border/50 border-border/50 border-y">
        {value.slice(0, MAX_OUTPUT_ENTRIES).map((entry) => {
          const identity = outputIdentity(entry);
          const occurrence = occurrences.get(identity) ?? 0;
          occurrences.set(identity, occurrence + 1);
          const itemPath = `${path}:${identity}:${occurrence}`;
          return (
            <div
              className="py-1.5"
              key={itemPath}
            >
              <MonadMcpOutputValue
                depth={depth + 1}
                emptyLabel={emptyLabel}
                falseLabel={falseLabel}
                omitTextBody={omitTextBody}
                path={itemPath}
                promoteTextBody={promoteTextBody}
                trueLabel={trueLabel}
                value={entry}
              />
            </div>
          );
        })}
        {value.length > MAX_OUTPUT_ENTRIES ? <span className="text-muted-foreground">…</span> : null}
      </div>
    );
  }
  const record = recordValue(value);
  if (!record) return <span className="text-muted-foreground">{emptyLabel}</span>;
  const summary = friendlyRecordSummary(record);
  if (summary) {
    return (
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="wrap-anywhere font-medium text-foreground">{summary.title}</span>
        {summary.detail ? <span className="shrink-0 text-muted-foreground">{summary.detail}</span> : null}
      </div>
    );
  }
  const entries = Object.entries(record).filter(
    ([key, entry]) => entry !== undefined && entry !== null && !(omitTextBody && key === 'text')
  );
  if (entries.length === 0) return <span className="text-muted-foreground">{emptyLabel}</span>;
  const orderedEntries = promoteTextBody
    ? [...entries.filter(([key]) => key !== 'text'), ...entries.filter(([key]) => key === 'text')]
    : entries;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-6 gap-y-0.5">
      {orderedEntries.slice(0, MAX_OUTPUT_ENTRIES).map(([key, entry]) => {
        if (promoteTextBody && key === 'text' && typeof entry === 'string') {
          return (
            <MonadMcpBodyText
              key={`${path}:${key}`}
              text={entry}
            />
          );
        }
        const nestedRecord = recordValue(entry);
        const nestedRecordList = Array.isArray(entry) && entry.some((item) => recordValue(item));
        const isGroup = (nestedRecord && !friendlyRecordSummary(nestedRecord)) || (promoteTextBody && nestedRecordList);
        if (isGroup) {
          return (
            <section
              className="col-span-full min-w-0 pt-2"
              data-slot="monad-mcp-output-group"
              key={`${path}:${key}`}
            >
              <h4
                className="mb-1 font-medium text-muted-foreground"
                data-slot="monad-mcp-output-group-label"
              >
                {friendlyOutputKey(key)}
              </h4>
              <MonadMcpOutputValue
                depth={depth + 1}
                emptyLabel={emptyLabel}
                falseLabel={falseLabel}
                omitTextBody={omitTextBody}
                path={`${path}:${key}`}
                promoteTextBody={promoteTextBody}
                trueLabel={trueLabel}
                value={entry}
              />
            </section>
          );
        }
        return (
          <div
            className="grid min-w-0 grid-cols-[minmax(7.5rem,10rem)_minmax(0,1fr)] items-start gap-x-3 py-0.5"
            data-slot="monad-mcp-output-field"
            key={`${path}:${key}`}
          >
            <span
              className="text-muted-foreground"
              data-slot="monad-mcp-output-field-label"
            >
              {friendlyOutputKey(key)}
            </span>
            <div
              className="min-w-0"
              data-slot="monad-mcp-output-field-value"
            >
              <MonadMcpOutputValue
                depth={depth + 1}
                emptyLabel={emptyLabel}
                falseLabel={falseLabel}
                omitTextBody={omitTextBody}
                path={`${path}:${key}`}
                promoteTextBody={promoteTextBody}
                trueLabel={trueLabel}
                value={entry}
              />
            </div>
          </div>
        );
      })}
      {orderedEntries.length > MAX_OUTPUT_ENTRIES ? <span className="text-muted-foreground">…</span> : null}
    </div>
  );
}

function MonadMcpBodyText({ text }: { text: string }) {
  return (
    <div
      className="col-span-full min-w-0 pt-1.5"
      data-slot="monad-mcp-output-body"
    >
      <p className="wrap-anywhere whitespace-pre-wrap text-foreground">{boundedOutputText(text)}</p>
    </div>
  );
}

type MonadPlanTodo = {
  id?: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
};

function monadPlanTodos(toolName: MonadMcpToolName, output: unknown): MonadPlanTodo[] | undefined {
  if (!toolName.startsWith('project_plan_')) return undefined;
  const record = recordValue(output);
  if (!record) return [];
  const plan = recordValue(record.plan);
  const list = Array.isArray(plan?.todos) ? plan.todos : Array.isArray(record.todos) ? record.todos : undefined;
  if (list) return list.flatMap(monadPlanTodo);
  const todo = monadPlanTodo(record.todo);
  return todo.length > 0 ? todo : [];
}

function monadPlanTodo(value: unknown): MonadPlanTodo[] {
  const record = recordValue(value);
  if (!record || typeof record.text !== 'string' || !record.text.trim()) return [];
  const status =
    record.status === 'completed' || record.status === 'in_progress' || record.status === 'pending'
      ? record.status
      : 'pending';
  return [{ ...(typeof record.id === 'string' ? { id: record.id } : {}), status, text: record.text }];
}

function MonadPlanTodoList({
  completedLabel,
  emptyLabel,
  inProgressLabel,
  pendingLabel,
  todos
}: {
  completedLabel: string;
  emptyLabel: string;
  inProgressLabel: string;
  pendingLabel: string;
  todos: MonadPlanTodo[];
}) {
  if (todos.length === 0) return <span className="text-muted-foreground">{emptyLabel}</span>;
  return (
    <ul className="divide-y divide-border/50 border-border/50 border-y">
      {todos.map((todo) => {
        const completed = todo.status === 'completed';
        const label = todo.status === 'in_progress' ? inProgressLabel : completed ? completedLabel : pendingLabel;
        return (
          <li
            className="flex min-w-0 items-start gap-2 py-1.5"
            key={todo.id ?? `${todo.status}:${todo.text}`}
          >
            <HugeiconsIcon
              aria-label={label}
              className={cn(
                'mt-0.5 size-4 shrink-0 text-muted-foreground',
                completed && 'text-success',
                todo.status === 'in_progress' && 'text-info'
              )}
              icon={completed ? CheckmarkSquare02Icon : todo.status === 'in_progress' ? Clock03Icon : SquareIcon}
            />
            <span
              className={cn('wrap-anywhere min-w-0 text-foreground', completed && 'text-muted-foreground line-through')}
            >
              {todo.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function friendlyRecordSummary(record: Record<string, unknown>): { detail?: string; title: string } | undefined {
  const title = [record.displayName, record.name].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  if (!title) return undefined;
  const detail = typeof record.status === 'string' && record.status.trim() ? record.status : undefined;
  if (record.displayName === undefined && detail === undefined) return undefined;
  return { title, ...(detail ? { detail } : {}) };
}

function boundedOutputText(value: string): string {
  return value.length > MAX_OUTPUT_TEXT ? `${value.slice(0, MAX_OUTPUT_TEXT)}…` : value;
}

function outputIdentity(value: unknown): string {
  const record = recordValue(value);
  const identity = record?.id ?? record?.messageId ?? record?.displayName ?? record?.name;
  if (typeof identity === 'string' || typeof identity === 'number') return String(identity);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function friendlyMonadMcpOutput(output: unknown): unknown {
  const parsed = parseJsonValue(output);
  if (Array.isArray(parsed)) {
    const content = mcpTextContent(parsed).map(parseJsonValue);
    const data = content.find((entry) => typeof entry !== 'string');
    if (data !== undefined) return friendlyMonadMcpOutput(data);
    const text = content.filter((entry): entry is string => typeof entry === 'string').join('\n');
    return text || parsed;
  }
  const record = recordValue(parsed);
  if (!record) return parsed;
  if (record.Err !== undefined && record.Err !== null) return friendlyMonadMcpOutput(record.Err);
  if (record.Ok !== undefined && record.Ok !== null) return friendlyMonadMcpOutput(record.Ok);
  if (record.error !== undefined && record.error !== null) return friendlyMonadMcpOutput(record.error);

  const content = mcpTextContent(record.content).map(parseJsonValue);
  const structured = parseJsonValue(record.structuredContent);
  const structuredRecord = recordValue(structured);
  if (content.length > 0 || structured !== undefined) {
    const text = content.filter((entry): entry is string => typeof entry === 'string').join('\n');
    const data = content.find((entry) => typeof entry !== 'string');
    if (structuredRecord) return { ...(text ? { message: text } : {}), ...structuredRecord };
    if (structured !== undefined && structured !== null)
      return text ? { message: text, result: structured } : structured;
    if (data !== undefined) return data;
    if (text) return text;
  }
  return parsed;
}

function mcpTextContent(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = recordValue(entry);
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if ((!text.startsWith('{') || !text.endsWith('}')) && (!text.startsWith('[') || !text.endsWith(']'))) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function friendlyOutputKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => (part.toLowerCase() === 'id' ? 'ID' : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`))
    .join(' ');
}
