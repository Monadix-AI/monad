import type { ProjectCanvas } from '../presets/types';
import type { ActivityRow, ActivityStatus } from '../types';

import { useCallback, useState } from 'react';

import { VirtualList } from '@/components/ui/VirtualList';
import { mono, sans } from '../styles';
import { WorkOutput } from './WorkOutput';

type Filter = 'all' | 'tools' | 'delegations';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'tools', label: 'Tool calls' },
  { key: 'delegations', label: 'Delegations' }
];

const statusColor = (s: ActivityStatus): string =>
  s === 'ok' ? 'var(--success)' : s === 'error' ? 'var(--destructive)' : 'var(--accent-blue)';
const statusBg = (s: ActivityStatus): string =>
  s === 'ok'
    ? 'color-mix(in srgb, var(--success) 14%, transparent)'
    : s === 'error'
      ? 'color-mix(in srgb, var(--destructive) 14%, transparent)'
      : 'color-mix(in srgb, var(--accent-blue) 16%, transparent)';
const statusLabel = (s: ActivityStatus): string =>
  s === 'ok' ? 'Done' : s === 'error' ? 'Needs attention' : 'Running';

function matches(row: ActivityRow, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'delegations') return row.tool.includes('delegate');
  return !row.tool.includes('delegate');
}

function ActivityAvatar({ av }: { av: string }): React.ReactElement {
  return (
    <span
      style={{
        flex: 'none',
        width: 26,
        height: 26,
        borderRadius: 7,
        border: `1px solid ${'var(--accent-blue)'}`,
        background: 'var(--accent-blue-soft)',
        color: 'var(--accent-blue)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: mono,
        fontSize: 9
      }}
    >
      {av}
    </span>
  );
}

function ActivityRowView({
  row,
  last,
  expanded,
  onExpandedChange,
  onNativeInput,
  onNativeStop
}: {
  row: ActivityRow;
  last: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onNativeInput: (id: string, input: string) => void;
  onNativeStop: (id: string) => void;
}): React.ReactElement {
  const [input, setInput] = useState('');
  const nativeCli = row.tool.startsWith('native-cli:');
  const send = (): void => {
    if (!input) return;
    onNativeInput(row.id, input.endsWith('\n') ? input : `${input}\n`);
    setInput('');
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: '9px 0',
        borderBottom: last ? 'none' : `1px solid ${'color-mix(in srgb, var(--border) 58%, transparent)'}`
      }}
    >
      <ActivityAvatar av={row.av} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: sans, fontSize: 14, fontWeight: 500, color: 'var(--foreground)' }}>{row.tool}</span>
        {row.detail !== row.tool ? (
          <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--muted-foreground)' }}> · {row.detail}</span>
        ) : null}
        {row.output ? (
          <WorkOutput
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            output={row.output}
          />
        ) : null}
        {nativeCli ? (
          <div style={{ marginTop: 8, display: 'flex', gap: 7 }}>
            <input
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Send input to CLI"
              style={{
                flex: 1,
                minWidth: 0,
                border: `1px solid ${'var(--border)'}`,
                borderRadius: 8,
                background: 'var(--background)',
                color: 'var(--foreground)',
                fontFamily: mono,
                fontSize: 12,
                padding: '5px 7px'
              }}
              value={input}
            />
            <button
              className="workplace-action"
              disabled={!input}
              onClick={send}
              style={{
                border: `1px solid ${'var(--accent-blue)'}`,
                borderRadius: 8,
                background: 'var(--accent-blue)',
                color: 'var(--primary-foreground)',
                fontFamily: sans,
                fontSize: 12,
                fontWeight: 600,
                padding: '5px 10px',
                cursor: input ? 'pointer' : 'default',
                opacity: input ? 1 : 0.55
              }}
              type="button"
            >
              Send
            </button>
            <button
              className="workplace-action"
              onClick={() => onNativeStop(row.id)}
              style={{
                border: `1px solid ${'var(--border)'}`,
                borderRadius: 8,
                background: 'var(--card)',
                color: 'var(--muted-foreground)',
                fontFamily: sans,
                fontSize: 12,
                fontWeight: 600,
                padding: '5px 10px',
                cursor: 'pointer'
              }}
              type="button"
            >
              Stop
            </button>
          </div>
        ) : null}
      </div>
      <span
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: statusColor(row.status),
          background: statusBg(row.status),
          border: `1px solid ${statusColor(row.status)}`,
          borderRadius: 999,
          flex: 'none',
          padding: '2px 7px',
          marginTop: -1
        }}
      >
        {statusLabel(row.status)}
      </span>
    </div>
  );
}

export function ActivityLog({ room }: { room: ProjectCanvas }): React.ReactElement {
  const [filter, setFilter] = useState<Filter>('all');
  // Lifted out of WorkOutput so an expanded row survives Virtuoso unmounting it on scroll.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const setExpanded = useCallback((id: string, expanded: boolean) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const rows = room.activity.filter((r) => matches(r, filter));
  const lastId = rows.at(-1)?.id;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* filter row */}
      <div
        style={{
          flex: 'none',
          padding: '12px 18px 10px',
          borderBottom: `1px solid ${'var(--border)'}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap'
        }}
      >
        <span style={{ fontFamily: sans, fontSize: 13, fontWeight: 600, color: 'var(--foreground)', marginRight: 4 }}>
          Activity
        </span>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              className="workplace-action"
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                fontSize: 13,
                fontFamily: sans,
                fontWeight: active ? 600 : 500,
                border: active ? `1px solid ${'var(--accent-blue)'}` : `1px solid ${'var(--border)'}`,
                background: active ? 'var(--accent-blue-soft)' : 'var(--card)',
                color: active ? 'var(--accent-blue)' : 'var(--muted-foreground)',
                borderRadius: 999,
                padding: '4px 11px',
                cursor: 'pointer'
              }}
              type="button"
            >
              {f.label}
            </button>
          );
        })}
        <span style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 11, color: 'var(--muted-foreground)' }}>
          Live updates
        </span>
      </div>

      {/* timeline */}
      {rows.length === 0 ? (
        <div
          className="scwf-scroll"
          style={{ flex: 1, overflowY: 'auto', padding: '10px 18px 18px', background: 'var(--card)' }}
        >
          <div
            style={{
              margin: '24px auto 0',
              maxWidth: 340,
              textAlign: 'center',
              fontFamily: sans,
              fontSize: 14,
              lineHeight: 1.6,
              color: 'var(--muted-foreground)',
              padding: '18px 20px',
              border: `1px solid ${'var(--border)'}`,
              borderRadius: 12,
              background: 'var(--muted)'
            }}
          >
            No activity yet. Tool calls, approvals, and delegated work will appear here after an agent starts working.
          </div>
        </div>
      ) : (
        <VirtualList
          className="scwf-scroll"
          footer={<div style={{ height: 18 }} />}
          getKey={(row) => row.id}
          header={<div style={{ height: 10 }} />}
          items={rows}
          renderItem={(row) => (
            <ActivityRowView
              expanded={expandedIds.has(row.id)}
              last={row.id === lastId}
              onExpandedChange={(v) => setExpanded(row.id, v)}
              onNativeInput={(id, input) => void room.sendNativeCliInput(id, input)}
              onNativeStop={(id) => void room.stopNativeCli(id)}
              row={row}
            />
          )}
          style={{ flex: 1, paddingLeft: 18, paddingRight: 18, background: 'var(--card)' }}
        />
      )}
    </div>
  );
}
