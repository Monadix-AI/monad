import type { RawFrameRow } from './raw-view.ts';

import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';

const STREAM_LABEL: Record<RawFrameRow['stream'], string> = {
  stdout: 'stdout',
  stderr: 'stderr',
  pty: 'pty',
  'app-server': 'app-server',
  unknown: 'raw'
};

// The raw plane renders exact provider frames verbatim, one row per frame. This is a privileged
// diagnostic surface, so preview text is user-selectable but never markdown-rendered.
export function RawObservationList({ rows }: { rows: RawFrameRow[] }): React.ReactElement {
  if (rows.length === 0) {
    return (
      <div
        data-observation-raw="empty"
        style={{
          alignItems: 'center',
          boxSizing: 'border-box',
          color: 'var(--muted-foreground)',
          display: 'flex',
          fontFamily: sans,
          fontSize: 13,
          height: '100%',
          justifyContent: 'center',
          padding: 14,
          textAlign: 'center',
          width: '100%'
        }}
      >
        No raw frames yet
      </div>
    );
  }
  return (
    <div
      className="scwf-scroll monad-selectable"
      data-observation-raw="list"
      role="log"
      style={{
        boxSizing: 'border-box',
        display: 'grid',
        gap: 6,
        height: '100%',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        padding: '12px 14px 62px',
        width: '100%'
      }}
    >
      {rows.map((row, index) => (
        <div
          data-observation-raw-row={row.cursor}
          // biome-ignore lint/suspicious/noArrayIndexKey: provider-native history rows can share (or omit) a cursor; the position disambiguates.
          key={`${row.cursor}:${index}`}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--secondary)',
            boxSizing: 'border-box',
            display: 'grid',
            gap: 4,
            padding: '8px 10px'
          }}
        >
          <div
            style={{
              alignItems: 'baseline',
              color: 'var(--muted-foreground)',
              display: 'flex',
              fontFamily: mono,
              fontSize: 10,
              gap: 8,
              justifyContent: 'space-between'
            }}
          >
            <span style={{ fontWeight: 700, textTransform: 'uppercase' }}>{STREAM_LABEL[row.stream]}</span>
            <span
              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={row.cursor}
            >
              {row.cursor}
            </span>
          </div>
          <pre
            style={{
              color: 'var(--foreground)',
              fontFamily: mono,
              fontSize: 12,
              lineHeight: 1.45,
              margin: 0,
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap'
            }}
          >
            {row.preview}
          </pre>
        </div>
      ))}
    </div>
  );
}
