import type { MeshAgentStreamView, Participant } from '../../../experience/types.ts';
import type { AgentObservationCard } from './card-projection.ts';
import type { ObservationItem, ObservationTimelineEntry } from './types.ts';

import { DefaultObservationToolPair, ObservationMeta, ObservationText } from '@monad/ui';
import { memo } from 'react';

import { codexItemSummary } from '../../../../agent-adapters/codex/observation/observation-message-group.ts';
import { workplaceExperienceT } from '../../../i18n.ts';
import { renderPrivateObservationCard } from './adapters.ts';
import { ObservationCardShell, ObservationToolCardShell, toolCallSummary } from './card-shell.tsx';
import {
  CodexFileChangeCard,
  claudeFileChangeView,
  codexFileChangeView,
  FileChangeToolHeader,
  fileChangeStatus
} from './codex-file-change-card.tsx';
import { CommandToolCard, CommandToolHeader, commandToolView } from './command-card.tsx';
import { ContextCompactionCard } from './context-compaction-card.tsx';
import { ObservationDisclosureScope } from './disclosure.tsx';
import {
  FileReadToolCard,
  FileReadToolHeader,
  fileReadToolPath,
  fileReadToolView,
  isFileReadToolCall
} from './file-read-card.tsx';
import { ImageToolCard, imageToolView } from './image-tool-card.tsx';
import { McpStartupProgressCard, mcpStartupView } from './mcp-startup-progress.tsx';
import { ObservationMessageCard } from './message-card.tsx';
import { MonadMcpToolCard, MonadMcpToolHeader } from './monad-mcp-card.tsx';
import { monadMcpToolView } from './monad-mcp-projection.ts';
import { PlanProgressCard, planProgressView } from './plan-progress.tsx';
import { observationContractRawEvents } from './provenance.ts';
import { ShellToolCard, ShellToolHeader, shellToolView } from './shell-card.tsx';

export type ObservationTimelineRow = {
  id: string;
  entries: ObservationTimelineEntry[];
};

function reasoningResponsePair(
  reasoningEntry: ObservationTimelineEntry,
  responseEntry: ObservationTimelineEntry
): boolean {
  if (
    reasoningEntry.kind !== 'public' ||
    responseEntry.kind !== 'public' ||
    reasoningEntry.card.kind !== 'reasoning' ||
    responseEntry.card.kind !== 'message'
  )
    return false;
  const reasoningEvent = cardEvent(reasoningEntry.card);
  const responseEvent = cardEvent(responseEntry.card);
  if (reasoningEvent?.kind !== 'reasoning' || responseEvent?.kind !== 'assistant-message') return false;
  const reasoningRaw = observationContractRawEvents(reasoningEntry.contractEvents);
  const responseRaw = observationContractRawEvents(responseEntry.contractEvents);
  return (
    reasoningRaw.length > 0 && responseRaw.length > 0 && JSON.stringify(reasoningRaw) === JSON.stringify(responseRaw)
  );
}

function observationCardIdentity(card: AgentObservationCard): string {
  return card.dedupeKey ?? card.id;
}

function cardEvent(card: AgentObservationCard): ObservationItem | undefined {
  const event = card.payload.event;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as ObservationItem) : undefined;
}

function cardToolCall(card: AgentObservationCard): ObservationItem | undefined {
  const event = card.payload.call;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as ObservationItem) : undefined;
}

function cardToolResult(card: AgentObservationCard): ObservationItem | undefined {
  const event = card.payload.result;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as ObservationItem) : undefined;
}

function reasoningSummary(entry: ObservationTimelineEntry, event: ObservationItem): string | undefined {
  if (event.summary) return event.summary;
  return observationContractRawEvents(entry.contractEvents)
    .map(codexReasoningSummary)
    .find((summary) => summary !== undefined);
}

function codexReasoningSummary(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const params = record.params;
  const item =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>).item
      : undefined;
  const itemRecord =
    item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
  return codexItemSummary(itemRecord) ?? codexItemSummary(record);
}

function sameObservationItem(left: AgentObservationCard, right: AgentObservationCard): boolean {
  if (
    left.id !== right.id ||
    left.dedupeKey !== right.dedupeKey ||
    left.kind !== right.kind ||
    left.streaming !== right.streaming ||
    left.at !== right.at
  )
    return false;
  return JSON.stringify([left.payload, left.provenance]) === JSON.stringify([right.payload, right.provenance]);
}

function toolResultArrived(previous: AgentObservationCard, next: AgentObservationCard): boolean {
  return (
    previous.kind === 'tool' && next.kind === 'tool' && !('result' in previous.payload) && 'result' in next.payload
  );
}

function progressCardCanUpdate(card: AgentObservationCard): boolean {
  return card.kind === 'mcp-startup-progress' || card.kind === 'plan-progress';
}

export function reconcileObservationItems(
  previous: readonly AgentObservationCard[],
  next: readonly AgentObservationCard[]
): AgentObservationCard[] {
  if (previous.length === 0) return next as AgentObservationCard[];
  const sharedLength = Math.min(previous.length, next.length);
  const reconciled = [...next];
  let changed = previous.length !== next.length;
  for (let index = 0; index < sharedLength; index += 1) {
    const previousItem = previous[index];
    const nextItem = next[index];
    if (!previousItem || !nextItem || observationCardIdentity(previousItem) !== observationCardIdentity(nextItem)) {
      changed = true;
      continue;
    }
    const atMutableBoundary = index === sharedLength - 1;
    if (
      (atMutableBoundary || progressCardCanUpdate(previousItem) || toolResultArrived(previousItem, nextItem)) &&
      !sameObservationItem(previousItem, nextItem)
    ) {
      changed = true;
      continue;
    }
    reconciled[index] = previousItem;
  }
  if (!changed && reconciled.every((item, index) => item === previous[index]))
    return previous as AgentObservationCard[];
  return reconciled;
}

export function observationTimelineEntries(
  items: readonly MeshAgentStreamView['items'][number][],
  _provider: string,
  active = false
): ObservationTimelineEntry[] {
  const cards = items.filter((card) => card.kind !== 'system' && card.kind !== 'unknown');
  return cards.map((card, index) => {
    const event = cardEvent(card) ?? cardToolCall(card) ?? cardToolResult(card);
    const timestampEvent = event?.kind === 'assistant-message' || event?.kind === 'user-message' ? event : undefined;
    const streaming =
      card.kind === 'reasoning' && event ? active && index === cards.length - 1 && card.streaming : card.streaming;
    return {
      id: observationCardIdentity(card),
      kind: 'public',
      card: streaming === card.streaming ? card : { ...card, streaming },
      timestamp: timestampEvent ? (timestampEvent.at ?? card.at) : undefined,
      contractEvents: card.provenance.contractEvents
    };
  });
}

function visualRoleFromKind(kind: ObservationItem['kind']): 'user' | 'agent' | 'tool' | 'system' {
  if (kind === 'user-message') return 'user';
  if (kind === 'tool-call' || kind === 'tool-result') return 'tool';
  if (kind === 'context-compaction' || kind === 'system' || kind === 'unknown') return 'system';
  return 'agent';
}

export function observationToolVisualStatus({
  completed,
  error,
  status
}: {
  completed: boolean;
  error?: boolean;
  status?: string;
}): 'error' | 'running' | 'success' | undefined {
  const normalized = status?.trim().toLowerCase();
  if (error || normalized === 'error' || normalized === 'failed') return 'error';
  if (
    normalized === 'running' ||
    normalized === 'pending' ||
    normalized === 'in_progress' ||
    normalized === 'inprogress'
  )
    return 'running';
  if (completed || normalized === 'completed' || normalized === 'success' || normalized === 'succeeded')
    return 'success';
  return 'running';
}

function ObservationTimelineCard({
  entry,
  memberIdentities,
  provider
}: {
  entry: ObservationTimelineEntry;
  memberIdentities?: ReadonlyMap<string, Participant>;
  provider: string;
}): React.ReactElement {
  const t = workplaceExperienceT();
  if (entry.kind === 'private') {
    const rendered = renderPrivateObservationCard(entry.card);
    if (rendered) {
      return (
        <ObservationToolCardShell
          header={
            <ObservationMeta
              compact
              label="tool"
              quiet
              source={entry.card.provider}
              type={entry.card.type}
            />
          }
          kind="tool"
          timestamp={entry.timestamp}
        >
          {rendered}
        </ObservationToolCardShell>
      );
    }
  }
  const toolCall = entry.kind === 'public' && entry.card.kind === 'tool' ? cardToolCall(entry.card) : undefined;
  const toolResult = entry.kind === 'public' && entry.card.kind === 'tool' ? cardToolResult(entry.card) : undefined;
  const fileChange =
    entry.kind === 'public'
      ? (codexFileChangeView(entry.contractEvents) ?? claudeFileChangeView(toolCall, toolResult))
      : null;
  if (fileChange) {
    return (
      <ObservationToolCardShell
        header={<FileChangeToolHeader view={fileChange} />}
        kind="file-change"
        status={fileChangeStatus(fileChange.status)}
        timestamp={entry.timestamp}
      >
        <CodexFileChangeCard view={fileChange} />
      </ObservationToolCardShell>
    );
  }
  if (entry.kind === 'public' && entry.card.kind === 'tool') {
    const call = toolCall;
    const result = toolResult;
    const toolEvent = call ?? result;

    const image = imageToolView(call, result, entry.contractEvents);
    if (image) {
      return (
        <ObservationToolCardShell
          header={
            <ObservationMeta
              compact
              label="tool call"
              quiet
              showSource={false}
              source={provider}
              title={t(result ? 'web.workplace.image.generated' : 'web.workplace.image.generating')}
            />
          }
          kind="tool"
          status={observationToolVisualStatus({
            completed: !!result,
            status: result?.tool?.status ?? call?.tool?.status
          })}
          timestamp={entry.timestamp}
        >
          <ImageToolCard view={image} />
        </ObservationToolCardShell>
      );
    }

    if (call) {
      const monadMcp = monadMcpToolView(call, result, entry.contractEvents);
      if (monadMcp) {
        return (
          <ObservationToolCardShell
            error={monadMcp.isError}
            header={
              <MonadMcpToolHeader
                memberIdentities={memberIdentities}
                quiet
                view={monadMcp}
              />
            }
            kind="mcp"
            runningOrbState="connecting"
            status={observationToolVisualStatus({
              completed: !!result,
              error: monadMcp.isError,
              status: monadMcp.status ?? (result ? undefined : 'running')
            })}
            timestamp={entry.timestamp}
          >
            <MonadMcpToolCard
              memberIdentities={memberIdentities}
              view={monadMcp}
            />
          </ObservationToolCardShell>
        );
      }
    }
    if (call && isFileReadToolCall(call)) {
      const fileRead = result ? fileReadToolView(call, result, provider) : null;
      const pendingPath = fileReadToolPath(call);
      const pendingFileRead =
        !fileRead && pendingPath && call.tool?.name
          ? { type: call.tool.name, provider, path: pendingPath, content: '' }
          : null;
      if (fileRead) {
        return (
          <ObservationToolCardShell
            header={
              <FileReadToolHeader
                completed
                quiet
                view={fileRead}
              />
            }
            kind="file"
            status="success"
            timestamp={entry.timestamp}
          >
            <FileReadToolCard
              copyCodeLabel={t('web.copyCode')}
              copyPathLabel={t('web.copyPath')}
              view={fileRead}
            />
          </ObservationToolCardShell>
        );
      }
      return (
        <ObservationToolCardShell
          header={
            pendingFileRead ? (
              <FileReadToolHeader
                completed={false}
                quiet
                view={pendingFileRead}
              />
            ) : (
              <ObservationMeta
                compact
                label="tool call"
                preserveTitle
                quiet
                showSource={false}
                source={provider}
                title={call.tool?.name}
              />
            )
          }
          kind="file"
          status={observationToolVisualStatus({
            completed: !!result,
            status: result?.tool?.status ?? (result ? undefined : 'running')
          })}
          timestamp={entry.timestamp}
        >
          {pendingFileRead ? (
            <FileReadToolCard
              copyCodeLabel={t('web.copyCode')}
              copyPathLabel={t('web.copyPath')}
              view={pendingFileRead}
            />
          ) : result ? (
            <DefaultObservationToolPair
              callText={toolCallSummary(call.text ?? '')}
              callTool={call.tool?.name}
              provider={provider}
              resultText={result.text ?? ''}
              resultTool={result.tool?.name}
            />
          ) : null}
        </ObservationToolCardShell>
      );
    }
    if (call) {
      const shell = shellToolView(call, result, provider);
      if (shell) {
        const failed = shell.exitCode !== undefined ? shell.exitCode !== 0 : shell.status === 'failed';
        return (
          <ObservationToolCardShell
            error={failed}
            header={<ShellToolHeader view={shell} />}
            kind="command"
            status={observationToolVisualStatus({ completed: !!result, error: failed, status: shell.status })}
            timestamp={entry.timestamp}
          >
            <ShellToolCard
              copyCommandLabel={t('web.copyCommand')}
              copyOutputLabel={t('web.copyOutput')}
              view={shell}
            />
          </ObservationToolCardShell>
        );
      }
    }
    if (toolEvent) {
      const command = commandToolView(call ?? toolEvent, result ?? toolEvent, provider);
      if (command) {
        return (
          <ObservationToolCardShell
            error={
              command.exitCode !== undefined
                ? command.exitCode !== 0
                : command.status === 'failed' || command.status === 'error'
            }
            header={
              <CommandToolHeader
                quiet
                view={command}
              />
            }
            kind="tool"
            status={observationToolVisualStatus({
              completed: !!result,
              error:
                command.exitCode !== undefined
                  ? command.exitCode !== 0
                  : command.status === 'failed' || command.status === 'error',
              status: command.status
            })}
            timestamp={entry.timestamp}
          >
            <CommandToolCard
              quiet
              view={command}
            />
          </ObservationToolCardShell>
        );
      }
    }
    return (
      <ObservationToolCardShell
        header={
          <ObservationMeta
            compact
            label="tool call"
            quiet
            showSource={false}
            source={provider}
            title={toolEvent ? toolPairName(toolEvent) : 'tool'}
          />
        }
        kind="tool"
        status={observationToolVisualStatus({
          completed: !!result,
          status: toolEvent?.tool?.status
        })}
        timestamp={entry.timestamp}
      >
        <DefaultObservationToolPair
          callText={toolCallSummary(call?.text ?? '')}
          callTool={call?.tool?.name}
          provider={provider}
          resultText={result?.text ?? ''}
          resultTool={result?.tool?.name}
        />
      </ObservationToolCardShell>
    );
  }
  const entryEvent = entry.kind === 'public' ? cardEvent(entry.card) : undefined;
  if (entry.kind === 'public' && entry.card.kind === 'context-compaction' && entryEvent) {
    return <ContextCompactionCard text={entryEvent.text ?? ''} />;
  }
  if (entry.kind === 'public' && entry.card.kind === 'diagnostic' && entryEvent?.diagnostic) {
    const diagnostic = entryEvent.diagnostic;
    return (
      <ObservationCardShell
        header={
          <ObservationMeta
            compact
            label={diagnostic.severity}
            showSource={!!diagnostic.target}
            source={diagnostic.target ?? provider}
            title={diagnostic.message}
          />
        }
        timestamp={entry.timestamp}
        visualRole={diagnostic.severity}
      >
        {diagnostic.detail ? (
          <ObservationText
            contained
            observationRole={diagnostic.severity}
            text={diagnostic.detail}
          />
        ) : null}
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'public' && entry.card.kind === 'mcp-startup-progress') {
    return (
      <McpStartupProgressCard
        provider={provider}
        timestamp={entry.timestamp}
        view={mcpStartupView(entry.card.payload)}
      />
    );
  }
  if (entry.kind === 'public' && entry.card.kind === 'plan-progress') {
    return (
      <PlanProgressCard
        provider={provider}
        timestamp={entry.timestamp}
        view={planProgressView(entry.card.payload)}
      />
    );
  }
  if (entry.kind === 'public' && entry.card.kind === 'reasoning' && entryEvent) {
    return (
      <ObservationMessageCard
        messageRole="reasoning"
        reasoning={{
          durationMs: entryEvent.durationMs,
          hasContent: entryEvent.hasContent,
          summary: reasoningSummary(entry, entryEvent),
          streaming: entry.card.streaming,
          text: entryEvent.text ?? ''
        }}
        streaming={entry.card.streaming}
        text={entryEvent.text ?? ''}
        timestamp={entry.timestamp}
      />
    );
  }
  if (entry.kind === 'private') {
    return (
      <GenericObservationCard
        entry={entry}
        item={entry.card.item}
        provider={provider}
      />
    );
  }
  if (entry.kind === 'public' && entryEvent) {
    return (
      <GenericObservationCard
        entry={entry}
        item={entryEvent}
        provider={provider}
      />
    );
  }
  return (
    <ObservationCardShell
      header={
        <ObservationMeta
          compact
          label="system"
          source="unknown"
          type="unsupported"
        />
      }
      timestamp={entry.timestamp}
      visualRole="system"
    >
      <ObservationText
        observationRole="system"
        text="Unsupported observation card."
      />
    </ObservationCardShell>
  );
}

function GenericObservationCard({
  entry,
  item,
  provider
}: {
  entry: ObservationTimelineEntry;
  item: ObservationItem;
  provider: string;
}): React.ReactElement {
  const role = visualRoleFromKind(item.kind);
  if (item.kind === 'user-message' || item.kind === 'assistant-message') {
    return (
      <ObservationMessageCard
        messageRole={item.kind === 'user-message' ? 'user' : 'agent'}
        streaming={entry.kind === 'public' ? entry.card.streaming : false}
        text={item.text ?? ''}
        timestamp={entry.timestamp}
      />
    );
  }
  const header =
    role === 'user' ? null : (
      <ObservationMeta
        compact
        label={role}
        quiet={role === 'tool'}
        source={provider}
        type={item.tool?.name}
      />
    );
  if (role === 'tool') {
    return (
      <ObservationToolCardShell
        header={header}
        kind="tool"
        status={observationToolVisualStatus({
          completed: item.kind === 'tool-result',
          status: item.tool?.status
        })}
        timestamp={entry.timestamp}
      >
        <ObservationText
          observationRole={role}
          scrollable
          text={item.text ?? ''}
        />
      </ObservationToolCardShell>
    );
  }
  return (
    <ObservationCardShell
      header={header}
      timestamp={entry.timestamp}
      visualRole={role}
    >
      <ObservationText
        observationRole={role}
        text={item.text ?? ''}
      />
    </ObservationCardShell>
  );
}

export function observationTimelineRows(entries: ObservationTimelineEntry[]): ObservationTimelineRow[] {
  const rows: ObservationTimelineRow[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const next = entries[index + 1];
    if (next && reasoningResponsePair(entry, next)) {
      rows.push({ id: `${entry.id}:${next.id}`, entries: [entry, next] });
      index += 1;
      continue;
    }
    rows.push({ id: entry.id, entries: [entry] });
  }
  return rows;
}

function sameObservationEntrySource(left: ObservationTimelineEntry, right: ObservationTimelineEntry): boolean {
  if (left.id !== right.id || left.kind !== right.kind) return false;
  if (left.kind === 'private' && right.kind === 'private') return left.card.item === right.card.item;
  if (left.kind !== 'public' || right.kind !== 'public') return false;
  return (
    left.card === right.card ||
    (left.card.id === right.card.id &&
      left.card.kind === right.card.kind &&
      left.card.streaming === right.card.streaming &&
      JSON.stringify([left.card.payload, left.card.provenance]) ===
        JSON.stringify([right.card.payload, right.card.provenance]))
  );
}

export function reconcileObservationTimelineRows(
  previous: readonly ObservationTimelineRow[],
  next: readonly ObservationTimelineRow[]
): ObservationTimelineRow[] {
  if (previous.length === 0) return next as ObservationTimelineRow[];
  const reusable = new Map(previous.map((row) => [row.id, row]));
  const reconciled = next.map((row) => {
    const candidate = reusable.get(row.id);
    if (!candidate || candidate.entries.length !== row.entries.length) return row;
    return candidate.entries.every((entry, index) => {
      const nextEntry = row.entries[index];
      return nextEntry ? sameObservationEntrySource(entry, nextEntry) : false;
    })
      ? candidate
      : row;
  });
  if (reconciled.length === previous.length && reconciled.every((row, index) => row === previous[index]))
    return previous as ObservationTimelineRow[];
  return reconciled;
}

function ObservationTimelineRowViewImpl({
  memberIdentities,
  row,
  provider
}: {
  memberIdentities?: ReadonlyMap<string, Participant>;
  row: ObservationTimelineRow;
  provider: string;
}): React.ReactElement | null {
  const first = row.entries[0];
  const second = row.entries[1];
  if (first && second && reasoningResponsePair(first, second) && first.kind === 'public' && second.kind === 'public') {
    const reasoningEvent = cardEvent(first.card);
    const responseEvent = cardEvent(second.card);
    if (reasoningEvent && responseEvent) {
      return (
        <ObservationDisclosureScope id={first.id}>
          <ObservationMessageCard
            messageRole="agent"
            reasoning={{
              durationMs: reasoningEvent.durationMs,
              hasContent: reasoningEvent.hasContent,
              summary: reasoningSummary(first, reasoningEvent),
              streaming: first.card.streaming,
              text: reasoningEvent.text ?? ''
            }}
            streaming={second.card.streaming}
            text={responseEvent.text ?? ''}
            timestamp={second.timestamp}
          />
        </ObservationDisclosureScope>
      );
    }
  }
  return first ? (
    <ObservationDisclosureScope id={row.id}>
      <ObservationTimelineCard
        entry={first}
        memberIdentities={memberIdentities}
        provider={provider}
      />
    </ObservationDisclosureScope>
  ) : null;
}

export const ObservationTimelineRowView = memo(ObservationTimelineRowViewImpl);

function _ObservationTimelineCards({
  entries,
  memberIdentities,
  provider
}: {
  entries: ObservationTimelineEntry[];
  memberIdentities?: ReadonlyMap<string, Participant>;
  provider: string;
}): React.ReactElement {
  return (
    <>
      {observationTimelineRows(entries).map((row) => (
        <ObservationTimelineRowView
          key={row.id}
          memberIdentities={memberIdentities}
          provider={provider}
          row={row}
        />
      ))}
    </>
  );
}

function toolPairName(item: ObservationItem): string {
  if (item.tool?.name) return item.tool.name;
  const textName = /^Tool call\s+([^\s]+)/.exec((item.text ?? '').trim())?.[1];
  if (textName) return textName;
  return 'tool';
}
