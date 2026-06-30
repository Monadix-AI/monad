import { useEffect, useMemo, useRef, useState } from 'react';

import { humanReadableCliOutput } from './cli-output';
import { mono, sans } from './styles';

function latestLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? text.trim();
}

interface WorkOutputProps {
  output: string;
  maxHeight?: number;
  /** Controlled expand state. When omitted, WorkOutput keeps its own. Lift it when the row
      can unmount and remount (e.g. inside a virtualized list) so the state survives. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export function WorkOutput({
  output,
  maxHeight = 180,
  expanded: expandedProp,
  onExpandedChange
}: WorkOutputProps): React.ReactElement {
  const [expandedSelf, setExpandedSelf] = useState(false);
  const expanded = expandedProp ?? expandedSelf;
  const toggleExpanded = () => {
    const next = !expanded;
    onExpandedChange?.(next);
    if (expandedProp === undefined) setExpandedSelf(next);
  };
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const readableOutput = useMemo(() => humanReadableCliOutput(output), [output]);
  const snippet = useMemo(() => latestLine(readableOutput), [readableOutput]);
  const outputLength = output.length;

  useEffect(() => {
    if (!expanded || !follow || outputLength === 0) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [expanded, follow, outputLength]);

  return (
    <div style={{ marginTop: 5, minWidth: 0 }}>
      <button
        className="workplace-action"
        onClick={toggleExpanded}
        style={{
          width: '100%',
          minHeight: 24,
          border: `1px solid ${'var(--border)'}`,
          borderRadius: 6,
          background: 'var(--muted)',
          color: 'var(--muted-foreground)',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          alignItems: 'center',
          gap: 8,
          padding: '3px 6px',
          cursor: 'pointer',
          textAlign: 'left'
        }}
        title={expanded ? 'Hide details' : 'Show details'}
        type="button"
      >
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: mono,
            fontSize: 11,
            lineHeight: 1.4
          }}
        >
          {snippet}
        </span>
        <span style={{ fontFamily: sans, fontSize: 11, fontWeight: 600, color: 'var(--foreground)' }}>
          {expanded ? 'Hide' : 'Details'}
        </span>
      </button>

      {expanded ? (
        <div
          style={{
            marginTop: 6,
            border: `1px solid ${'var(--border)'}`,
            borderRadius: 6,
            background: 'var(--card)',
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              padding: '5px 6px',
              borderBottom: `1px solid ${'var(--border)'}`
            }}
          >
            <button
              className="workplace-action"
              onClick={() => setFollow((v) => !v)}
              style={{
                border: `1px solid ${follow ? 'var(--accent-blue)' : 'var(--border)'}`,
                borderRadius: 999,
                background: follow ? 'var(--accent-blue-soft)' : 'transparent',
                color: follow ? 'var(--accent-blue)' : 'var(--muted-foreground)',
                cursor: 'pointer',
                fontFamily: sans,
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 7px'
              }}
              type="button"
            >
              {follow ? 'Following' : 'Follow latest'}
            </button>
          </div>
          <pre
            className="scwf-scroll"
            ref={bodyRef}
            style={{
              margin: 0,
              maxHeight,
              overflow: 'auto',
              padding: '7px 8px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: mono,
              fontSize: 11,
              lineHeight: 1.45,
              color: 'var(--muted-foreground)'
            }}
          >
            {readableOutput || output}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
