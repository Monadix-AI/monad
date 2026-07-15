import type { DeveloperLogRecord, Event, ProjectId } from '@monad/protocol';

import { BugIcon, Cancel01Icon, ClipboardIcon, Delete02Icon, PauseIcon, PlayIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { workspaceMono as mono } from '@monad/ui/components/AgentAvatar';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useMonadRuntime } from '#/lib/monad-runtime-provider';
import {
  appendProjectDebugTrace,
  clearProjectDebugTrace,
  type ProjectDebugTraceEntry,
  projectDebugTraceSnapshot,
  subscribeProjectDebugTrace
} from '#/lib/project-debug-trace';
import { DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED, useProjectDebugStore } from './project-debug-store';

type DebugFilter = 'all' | 'http' | 'sse' | 'external-agent' | 'approval' | 'log' | 'error';

const FILTERS: DebugFilter[] = ['all', 'http', 'sse', 'external-agent', 'approval', 'log', 'error'];

export function filterDebugTraceEntries(
  entries: ProjectDebugTraceEntry[],
  filter: DebugFilter
): ProjectDebugTraceEntry[] {
  if (filter === 'all') return entries;
  if (filter === 'error') return entries.filter((entry) => entry.direction === 'error');
  if (filter === 'http') return entries.filter((entry) => entry.layer === 'http');
  if (filter === 'sse') return entries.filter((entry) => entry.layer === 'sse');
  if (filter === 'log') return entries.filter((entry) => entry.layer === 'log');
  if (filter === 'external-agent') {
    return entries.filter((entry) => entry.label.includes('external_agent') || entry.label.includes('external-agent'));
  }
  return entries.filter((entry) => entry.label.includes('approval'));
}

export function debugTraceText(entry: ProjectDebugTraceEntry): string {
  return JSON.stringify(entry.data ?? {}, null, 2);
}

export function formatDebugTimestamp(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone
  }).format(date);
}

function eventLabel(event: Event): string {
  return event.type;
}

function eventTraceData(event: Event): unknown {
  return {
    id: event.id,
    type: event.type,
    actorAgentId: event.actorAgentId,
    payload: event.payload,
    at: event.at
  };
}

function logLevelName(level: unknown): ProjectDebugTraceEntry['direction'] {
  if (typeof level !== 'number') return 'internal';
  if (level >= 50) return 'error';
  return level >= 30 ? 'output' : 'internal';
}

export function logRecordToDebugTrace(record: DeveloperLogRecord): {
  direction: ProjectDebugTraceEntry['direction'];
  layer: ProjectDebugTraceEntry['layer'];
  label: string;
  data: DeveloperLogRecord;
} {
  return {
    direction: logLevelName(record.level),
    layer: record.name === 'transport:http' ? 'http' : 'log',
    label: typeof record.event === 'string' ? record.event : (record.msg ?? record.name ?? 'log'),
    data: record
  };
}

export function ProjectDebugConsole({
  onClose,
  projectId
}: {
  onClose: () => void;
  projectId: ProjectId | null;
}): React.ReactElement {
  const { client } = useMonadRuntime();
  const entries = useSyncExternalStore(
    subscribeProjectDebugTrace,
    projectDebugTraceSnapshot,
    projectDebugTraceSnapshot
  );
  const [filter, setFilter] = useState<DebugFilter>('all');
  const [paused, setPaused] = useState(false);
  const showDevSystemMessagesInStream = useProjectDebugStore((state) => state.showDevSystemMessagesInStream);
  const setShowDevSystemMessagesInStream = useProjectDebugStore((state) => state.setShowDevSystemMessagesInStream);
  const pausedRef = useRef(paused);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const visibleEntries = useMemo(() => filterDebugTraceEntries(entries, filter), [entries, filter]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (!projectId) return;
    appendProjectDebugTrace({
      direction: 'internal',
      layer: 'web',
      label: 'debug.subscribe',
      sessionId: projectId,
      data: { projectId }
    });
    return client.streamEvents(projectId, (event) => {
      if (pausedRef.current) return;
      appendProjectDebugTrace({
        direction: 'event',
        layer: 'sse',
        label: eventLabel(event),
        sessionId: projectId,
        data: eventTraceData(event)
      });
    });
  }, [client, projectId]);

  useEffect(() => {
    if (!projectId) return;
    return client.streamSessionLogs(projectId, (record) => {
      if (pausedRef.current) return;
      const trace = logRecordToDebugTrace(record);
      appendProjectDebugTrace({
        direction: trace.direction,
        layer: trace.layer,
        label: trace.label,
        sessionId: projectId,
        data: trace.data
      });
    });
  }, [client, projectId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || paused) return;
    if (visibleEntries.length === 0) return;
    node.scrollTop = node.scrollHeight;
  }, [visibleEntries.length, paused]);

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(visibleEntries, null, 2));
  };

  return (
    <div
      style={{
        position: 'fixed',
        right: 18,
        bottom: 18,
        zIndex: 80,
        width: 'min(760px, calc(100vw - 36px))',
        height: 'min(560px, calc(100vh - 36px))',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--card)',
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--foreground)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <HugeiconsIcon
          aria-hidden="true"
          icon={BugIcon}
          size={16}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Developer Mode</div>
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--muted-foreground)' }}>
            {projectId ?? 'No project'} · {visibleEntries.length}/{entries.length}
          </div>
        </div>
        <button
          aria-label={paused ? 'Resume debug trace' : 'Pause debug trace'}
          className="workplace-action"
          onClick={() => setPaused((value) => !value)}
          type="button"
        >
          {paused ? (
            <HugeiconsIcon
              icon={PlayIcon}
              size={14}
            />
          ) : (
            <HugeiconsIcon
              icon={PauseIcon}
              size={14}
            />
          )}
        </button>
        <button
          aria-label="Copy debug trace"
          className="workplace-action"
          onClick={() => void copy()}
          type="button"
        >
          <HugeiconsIcon
            icon={ClipboardIcon}
            size={14}
          />
        </button>
        <button
          aria-label="Clear debug trace"
          className="workplace-action"
          onClick={clearProjectDebugTrace}
          type="button"
        >
          <HugeiconsIcon
            icon={Delete02Icon}
            size={14}
          />
        </button>
        <button
          aria-label="Close developer mode"
          className="workplace-action"
          onClick={onClose}
          type="button"
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            size={14}
          />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        {FILTERS.map((item) => (
          <button
            key={item}
            onClick={() => setFilter(item)}
            style={{
              border: `1px solid ${filter === item ? 'var(--accent-blue)' : 'var(--border)'}`,
              background: filter === item ? 'color-mix(in srgb, var(--accent-blue) 16%, transparent)' : 'var(--card)',
              borderRadius: 999,
              color: 'var(--foreground)',
              fontFamily: mono,
              fontSize: 10,
              padding: '4px 8px'
            }}
            type="button"
          >
            {item}
          </button>
        ))}
      </div>
      {DEV_SYSTEM_MESSAGES_IN_STREAM_ENABLED ? (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--border)',
            color: 'var(--muted-foreground)',
            fontFamily: mono,
            fontSize: 11
          }}
        >
          <input
            checked={showDevSystemMessagesInStream}
            onChange={(event) => setShowDevSystemMessagesInStream(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>show dev system messages in stream</span>
        </label>
      ) : null}
      <div
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10, background: 'var(--background)' }}
      >
        {visibleEntries.length === 0 ? (
          <div style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>No trace entries.</div>
        ) : (
          visibleEntries.map((entry) => (
            <details
              key={entry.id}
              open={entry.direction === 'error'}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'var(--card)',
                marginBottom: 8,
                padding: '7px 9px'
              }}
            >
              <summary
                style={{
                  display: 'grid',
                  gridTemplateColumns: '82px 64px 88px 1fr',
                  gap: 8,
                  alignItems: 'center',
                  fontFamily: mono,
                  fontSize: 11
                }}
              >
                <span style={{ color: 'var(--muted-foreground)' }}>{formatDebugTimestamp(entry.at)}</span>
                <span>{entry.layer}</span>
                <span>{entry.direction}</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.label}
                </span>
              </summary>
              <pre
                style={{
                  margin: '8px 0 0',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: mono,
                  fontSize: 11,
                  lineHeight: 1.45,
                  color: 'var(--muted-foreground)'
                }}
              >
                {debugTraceText(entry)}
              </pre>
            </details>
          ))
        )}
      </div>
    </div>
  );
}
