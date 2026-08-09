import type { ComponentProps, SyntheticEvent } from 'react';

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@monad/ui';
import { Avatar, workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { useCallback, useEffect, useRef } from 'react';

import { acquireGlobalKeyboardInput } from '#/lib/global-keyboard-input-capture';
import { CliTerminalOutput } from './CliTerminalOutput';

export type CliTerminalModalStatus = 'running' | 'ok' | 'error';

function statusText(status: CliTerminalModalStatus): string {
  return status === 'ok' ? 'done' : status === 'error' ? 'error' : 'running';
}

function officialCliName(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes('gemini')) return 'Gemini CLI';
  if (normalized.includes('claude')) return 'Claude Code';
  if (normalized.includes('codex')) return 'OpenAI Codex';
  if (normalized.includes('qwen')) return 'Qwen Code';
  return name;
}

function statusPill(
  status: CliTerminalModalStatus,
  tone: 'default' | 'soft' | 'clear' | 'bright' = 'default'
): React.CSSProperties {
  const color =
    status === 'ok'
      ? tone === 'default'
        ? 'var(--success)'
        : '#74e7a3'
      : status === 'error'
        ? tone === 'default'
          ? 'var(--destructive)'
          : '#ff8c7b'
        : tone === 'bright'
          ? '#a8c2ff'
          : tone === 'clear'
            ? '#b9b4ff'
            : 'var(--accent-blue)';
  const background =
    status === 'ok'
      ? tone === 'default'
        ? 'color-mix(in srgb, var(--success) 14%, transparent)'
        : 'rgb(116 231 163 / 0.16)'
      : status === 'error'
        ? tone === 'default'
          ? 'color-mix(in srgb, var(--destructive) 14%, transparent)'
          : 'rgb(255 140 123 / 0.16)'
        : tone === 'bright'
          ? 'rgb(168 194 255 / 0.2)'
          : tone === 'clear'
            ? 'rgb(185 180 255 / 0.18)'
            : 'color-mix(in srgb, var(--accent-blue) 16%, transparent)';
  return {
    fontFamily: mono,
    fontSize: 10,
    color: tone === 'default' ? 'var(--foreground)' : '#eef3ff',
    border: `1px solid ${color}`,
    background,
    borderRadius: 5,
    padding: '2px 6px',
    flex: 'none',
    whiteSpace: 'nowrap'
  };
}

export function CliTerminalModal({
  title,
  subtitle,
  eyebrow,
  tag,
  icon,
  status,
  output,
  id,
  footerLabel,
  onInput,
  onClose,
  onStop,
  stopLabel
}: {
  title: string;
  subtitle: string;
  eyebrow?: string;
  tag?: string;
  icon?: ComponentProps<typeof Avatar>['icon'];
  avatarText?: string;
  status: CliTerminalModalStatus;
  output: string;
  id: string;
  footerLabel: string;
  onInput?: (input: string) => void;
  onClose: () => void;
  onStop?: () => void;
  stopLabel: string;
}): React.ReactElement {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const quit = () => {
    if (onStop) onStop();
    else onClose();
  };
  const stopModalEvent = (event: SyntheticEvent) => event.stopPropagation();
  const stopClipboardEvent = useCallback((event: SyntheticEvent) => event.stopPropagation(), []);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    return acquireGlobalKeyboardInput(modal);
  }, []);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) quit();
      }}
      open
    >
      <DialogContent
        className="z-80 h-[min(740px,calc(100dvh-64px))] min-h-[min(500px,calc(100dvh-32px))] border-0 bg-[#101620] text-[#f0f5ff] shadow-[0_22px_64px_rgb(0_0_0/0.4),inset_0_1px_0_rgb(255_255_255/0.07)]"
        onBeforeInput={stopModalEvent}
        onCopy={stopClipboardEvent}
        onCut={stopClipboardEvent}
        onInput={stopModalEvent}
        onKeyDown={stopModalEvent}
        onKeyPress={stopModalEvent}
        onKeyUp={stopModalEvent}
        onPaste={stopClipboardEvent}
        overlayClassName="z-[70] bg-[rgb(2_6_14/0.58)] backdrop-blur-[2px]"
        ref={modalRef}
        showCloseButton={false}
        size="wide"
      >
        <DialogHeader className="gap-2 px-5 pt-5 pr-5 pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar
              av={officialCliName(title).slice(0, 2).toUpperCase()}
              icon={icon}
              kind="agent"
              size={30}
            />
            <div className="min-w-0 flex-1">
              {eyebrow ? <p className="mb-1 font-medium text-[#aeb9ca] text-xs">{eyebrow}</p> : null}
              <div className="flex min-w-0 items-center gap-2">
                <DialogTitle
                  className="truncate"
                  style={{
                    fontFamily: sans,
                    fontSize: 'clamp(1.05rem, calc(var(--p-scale, 1) * 1.2rem), 1.38rem)',
                    lineHeight: 1.16,
                    fontWeight: 680,
                    color: '#f0f5ff',
                    letterSpacing: '-0.01em'
                  }}
                >
                  {officialCliName(title)}
                </DialogTitle>
                <span style={statusPill(status, 'soft')}>{statusText(status)}</span>
                {tag ? <span className="truncate text-[#aeb9ca] text-xs">{tag}</span> : null}
              </div>
            </div>
          </div>
          <DialogDescription
            className="text-[#c4cede]"
            style={{ fontFamily: sans, fontSize: 13, lineHeight: 1.5 }}
          >
            {subtitle}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex bg-[#070b11] p-3">
          <CliTerminalOutput
            key={id}
            maxHeight="none"
            minHeight={0}
            onInput={onInput}
            output={output}
            resetKey={id}
            style={{ flex: 1, height: '100%', minHeight: 0, border: 0, borderRadius: 8 }}
          />
        </DialogBody>
        <DialogFooter className="items-center border-white/10 bg-white/3 px-5 py-3 sm:justify-end">
          <p className="mr-auto text-[#aeb9ca] text-xs">{footerLabel}</p>
          <Button
            className="border-white/10 bg-[#202838] text-[#f0f5ff] hover:bg-[#2a3446] hover:text-white"
            onClick={quit}
            variant="outline"
          >
            {stopLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
