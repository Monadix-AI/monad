import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  MeshAgentEventSource,
  MeshAgentProviderEventContext,
  MeshAgentProviderEventPageContext,
  MeshAgentProviderEventPageRequestContext
} from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

import { readProviderEventFile } from '../shared/events/event-files.ts';
import { createOutputEventSource, createProjectedEventSource } from '../shared/events/event-source.ts';
import { claudeCodeObservationProjection } from './observation.ts';

interface ClaudeSdkHistoryDeps {
  getSessionMessages: typeof getSessionMessages;
}

interface ClaudeEventSourceDeps extends ClaudeSdkHistoryDeps {
  readFallbackOutput?: (context: MeshAgentProviderEventContext) => string | null | Promise<string | null>;
}

function claudeSdkMessageRecord(message: SessionMessage): Record<string, unknown> {
  return { ...message };
}

function claudeSdkMessagesOutput(messages: SessionMessage[]): string | null {
  if (messages.length === 0) return null;
  return messages.map((message) => JSON.stringify(claudeSdkMessageRecord(message))).join('\n');
}

function claudeHistoryEnd(cursor: string | undefined): number | null | undefined {
  if (!cursor) return undefined;
  const end = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(end) && end >= 0 && String(end) === cursor ? end : null;
}

export function createClaudeSdkEventPageReader(deps: ClaudeSdkHistoryDeps) {
  return async function readClaudeEventPage(
    context: MeshAgentProviderEventPageRequestContext
  ): Promise<MeshAgentProviderEventPageContext['page'] | null> {
    try {
      const cursorEnd = claudeHistoryEnd(context.request.before);
      if (cursorEnd === null) return null;
      if (cursorEnd !== undefined) {
        const start = Math.max(0, cursorEnd - context.request.limit);
        const messages = await deps.getSessionMessages(context.providerSessionRef, {
          dir: context.workingPath,
          limit: cursorEnd - start,
          offset: start,
          includeSystemMessages: true
        });
        return {
          items: messages.map(claudeSdkMessageRecord),
          ...(start > 0 ? { nextCursor: String(start) } : {})
        };
      }

      const messages = await deps.getSessionMessages(context.providerSessionRef, {
        dir: context.workingPath,
        includeSystemMessages: true
      });
      if (messages.length === 0) return null;
      const start = Math.max(0, messages.length - context.request.limit);
      return {
        items: messages.slice(start).map(claudeSdkMessageRecord),
        ...(start > 0 ? { nextCursor: String(start) } : {})
      };
    } catch {
      return null;
    }
  };
}

export function createClaudeSdkHistoryOutputReader(deps: ClaudeSdkHistoryDeps) {
  return async function readClaudeSdkHistoryOutput(context: MeshAgentProviderEventContext): Promise<string | null> {
    try {
      const messages = await deps.getSessionMessages(context.providerSessionRef, {
        dir: context.workingPath,
        includeSystemMessages: true
      });
      return claudeSdkMessagesOutput(messages);
    } catch {
      return null;
    }
  };
}

export function createClaudeEventSource(deps: ClaudeEventSourceDeps = { getSessionMessages }): MeshAgentEventSource {
  const source = createProjectedEventSource({
    provider: 'claude-code',
    projection: claudeCodeObservationProjection
  });
  const readPage = createClaudeSdkEventPageReader(deps);
  const fallback = deps.readFallbackOutput
    ? createOutputEventSource({
        provider: 'claude-code',
        projection: claudeCodeObservationProjection,
        readOutput: deps.readFallbackOutput
      })
    : undefined;

  return {
    ...source,
    readPage: async (context, request) => {
      const page = await readPage({
        ...context,
        request: {
          ...(request.before ? { before: request.before } : {}),
          limit: request.limit,
          sortDirection: 'desc',
          itemsView: 'full'
        }
      });
      if (!page) {
        return (await fallback?.readPage?.(context, request)) ?? { state: 'unavailable', reason: 'not-found' };
      }
      if (request.view === 'raw') {
        return {
          state: 'available',
          view: 'raw',
          records: page.items.map((data, index) => {
            const record = data && typeof data === 'object' && !Array.isArray(data) ? data : undefined;
            const providerIdentity = String(
              record && 'uuid' in record ? record.uuid : `${request.before ?? 'latest'}:${index}`
            );
            return { data, cursor: providerIdentity, providerIdentity };
          }),
          coverage: 'settled',
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
        };
      }
      const output = page.items.map((item) => JSON.stringify(item)).join('\n');
      return {
        state: 'available',
        view: 'convenience',
        events: output ? source.projectLive({ id: context.providerSessionRef, output, mode: 'events' }).events : [],
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      };
    }
  };
}

export function claudeTranscriptFallback(context: MeshAgentProviderEventContext): string | null {
  return readProviderEventFile({
    roots: [join(homedir(), '.claude', 'projects')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl']
  });
}
