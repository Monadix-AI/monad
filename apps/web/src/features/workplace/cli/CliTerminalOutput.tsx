import type { ITheme } from 'ghostty-web';
import type { CSSProperties } from 'react';

import { useEffect, useRef } from 'react';

import { terminalClipboardText } from './terminal-clipboard';
import { terminalOutputSyncPlan } from './terminal-output-sync';

const TERMINAL_THEME: ITheme = {
  background: '#0b0f14',
  foreground: '#d7dde8',
  cursor: '#d7dde8',
  selectionBackground: 'rgba(125, 140, 255, 0.28)',
  black: '#1f2430',
  red: '#ff6b6b',
  green: '#8bd88b',
  yellow: '#f5c76b',
  blue: '#7fb4ff',
  magenta: '#d6a4ff',
  cyan: '#70d6ff',
  white: '#d7dde8',
  brightBlack: '#687080',
  brightRed: '#ff8f8f',
  brightGreen: '#a8e6a3',
  brightYellow: '#ffe08a',
  brightBlue: '#9bc7ff',
  brightMagenta: '#e4bbff',
  brightCyan: '#9be7ff',
  brightWhite: '#ffffff'
};

interface CliTerminalOutputProps {
  output: string;
  minHeight?: number;
  maxHeight?: string | number;
  onInput?: (input: string) => void;
  resetKey?: string;
  style?: CSSProperties;
}

export function CliTerminalOutput({
  output,
  minHeight = 180,
  maxHeight = 'min(48vh, 420px)',
  onInput,
  resetKey,
  style
}: CliTerminalOutputProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<import('ghostty-web').Terminal | null>(null);
  const fitRef = useRef<import('ghostty-web').FitAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const inputDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const pasteDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const writtenOutputRef = useRef('');
  const outputRef = useRef(output);
  const onInputRef = useRef(onInput);

  outputRef.current = output;
  onInputRef.current = onInput;

  useEffect(() => {
    void resetKey;
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    host.replaceChildren();
    observerRef.current?.disconnect();
    observerRef.current = null;
    inputDisposableRef.current?.dispose();
    inputDisposableRef.current = null;
    pasteDisposableRef.current?.dispose();
    pasteDisposableRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitRef.current = null;
    writtenOutputRef.current = '';

    async function mountTerminal(): Promise<void> {
      const { FitAddon, Terminal, init } = await import('ghostty-web');
      await init();
      if (disposed || !hostRef.current) return;
      const computed = getComputedStyle(hostRef.current);
      const readColor = (name: string, fallback: string) => computed.getPropertyValue(name).trim() || fallback;
      const terminal = new Terminal({
        convertEol: true,
        cursorBlink: false,
        disableStdin: !onInputRef.current,
        fontFamily: readColor('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
        fontSize: 11,
        rows: 12,
        scrollback: 3000,
        theme: TERMINAL_THEME
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(hostRef.current);
      (terminal as { focus?: () => void }).focus?.();
      const pasteTarget = hostRef.current.querySelector('textarea') ?? hostRef.current;
      pasteTarget.focus();
      const handlePaste = (event: Event) => {
        if (!(event instanceof ClipboardEvent)) return;
        const text = terminalClipboardText(event.clipboardData);
        if (!text) return;
        event.preventDefault();
        event.stopPropagation();
        (terminal as { paste?: (text: string) => void }).paste?.(text) ?? onInputRef.current?.(text);
      };
      pasteTarget.addEventListener('paste', handlePaste, { capture: true });
      pasteDisposableRef.current = {
        dispose: () => pasteTarget.removeEventListener('paste', handlePaste, { capture: true })
      };
      inputDisposableRef.current = terminal.onData((input) => onInputRef.current?.(input));
      terminalRef.current = terminal;
      fitRef.current = fitAddon;
      try {
        fitAddon.fit();
      } catch {
        // The terminal can throw before the container has measurable dimensions.
      }
      if (outputRef.current) {
        terminal.write(outputRef.current);
        writtenOutputRef.current = outputRef.current;
      }
      const observer = new ResizeObserver(() => {
        try {
          fitAddon.fit();
        } catch {
          // Ignore transient zero-size layout during panel transitions.
        }
      });
      observer.observe(hostRef.current);
      observerRef.current = observer;
    }

    void mountTerminal();
    return () => {
      disposed = true;
      observerRef.current?.disconnect();
      observerRef.current = null;
      inputDisposableRef.current?.dispose();
      inputDisposableRef.current = null;
      pasteDisposableRef.current?.dispose();
      pasteDisposableRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      writtenOutputRef.current = '';
    };
  }, [resetKey]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const plan = terminalOutputSyncPlan(writtenOutputRef.current, output);
    if (plan.kind === 'replay') {
      terminal.reset();
      terminal.write('\x1b[3J\x1b[2J\x1b[H');
      if (plan.text) terminal.write(plan.text);
    } else if (plan.kind === 'append') {
      terminal.write(plan.text);
    }
    writtenOutputRef.current = plan.writtenOutput;
  }, [output]);

  return (
    <div
      style={{
        position: 'relative',
        minHeight,
        maxHeight,
        overflow: 'hidden',
        boxSizing: 'border-box',
        padding: 8,
        border: `1px solid ${'var(--border)'}`,
        borderRadius: 8,
        background: TERMINAL_THEME.background,
        ...style
      }}
    >
      <div
        ref={hostRef}
        style={{ height: '100%', minHeight: Math.max(0, minHeight - 16) }}
      />
      {output ? null : (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 8,
            display: 'flex',
            alignItems: 'flex-start',
            padding: '1px 2px',
            color: '#9aa4b5',
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            fontSize: 11,
            pointerEvents: 'none'
          }}
        >
          Waiting for CLI output…
        </div>
      )}
    </div>
  );
}
