import type { ReactElement, ReactNode } from 'react';

import { ChevronDownIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useEffect, useRef, useState } from 'react';

import { Button } from './Button';
import { ButtonGroup } from './ButtonGroup';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './DropdownMenu';

const closeMs = 160;

export type ComposerApprovalOption = {
  id: string;
  label: string;
};

export type ComposerApprovalSheetProps = {
  denyLabel: string;
  details?: ReactNode;
  moreOptionsLabel: string;
  onApprove: (optionId: string) => void;
  onDeny: () => void;
  options: ComposerApprovalOption[];
  prompt: ReactNode;
  queueLabel?: string;
  reviewLabel: string;
  source: ReactNode;
};

export type ComposerApprovalSheetKeyAction = 'approve' | 'deny' | 'ignore';

export function composerApprovalSheetKeyAction(input: {
  inButton: boolean;
  isComposing: boolean;
  key: string;
}): ComposerApprovalSheetKeyAction {
  if (input.isComposing) return 'ignore';
  if (input.key === 'Escape') return 'deny';
  if (input.key === 'Enter' && !input.inButton) return 'approve';
  return 'ignore';
}

export function ComposerApprovalSheet({
  denyLabel,
  details,
  moreOptionsLabel,
  onApprove,
  onDeny,
  options,
  prompt,
  queueLabel,
  reviewLabel,
  source
}: ComposerApprovalSheetProps): ReactElement | null {
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLFieldSetElement>(null);
  const primary = options[0];
  const secondary = options.slice(1);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  if (!primary) return null;

  const complete = (callback: () => void): void => {
    setClosing(true);
    window.setTimeout(callback, closeMs);
  };
  const approve = (optionId: string): void => complete(() => onApprove(optionId));
  const deny = (): void => complete(onDeny);

  return (
    <fieldset
      className={closing ? 'monad-ui-approval-sheet is-closing' : 'monad-ui-approval-sheet'}
      onKeyDown={(event) => {
        const action = composerApprovalSheetKeyAction({
          inButton: event.target instanceof HTMLButtonElement,
          isComposing: event.nativeEvent.isComposing,
          key: event.key
        });
        if (action === 'ignore') return;
        event.preventDefault();
        if (action === 'deny') deny();
        else approve(primary.id);
      }}
      ref={panelRef}
      style={{
        background: 'var(--popover)',
        border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
        borderRadius: 14,
        display: 'grid',
        gap: 12,
        margin: 0,
        overflow: 'visible',
        padding: '12px 14px',
        width: '100%'
      }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the sheet owns Enter and Escape while it replaces the composer.
      tabIndex={0}
    >
      <legend
        style={{
          height: 1,
          left: -10_000,
          overflow: 'hidden',
          position: 'absolute',
          top: 'auto',
          width: 1
        }}
      >
        {reviewLabel}
      </legend>
      <style>{`
        .monad-ui-approval-sheet {
          animation: monadUiApprovalIn 200ms cubic-bezier(.16,1,.3,1) both;
          transform-origin: bottom center;
        }
        .monad-ui-approval-sheet.is-closing {
          animation: monadUiApprovalOut ${closeMs}ms cubic-bezier(.7,0,.84,0) both;
        }
        @keyframes monadUiApprovalIn {
          0% { opacity: 0; transform: translateY(12px) scale(.99); filter: blur(1px); }
          100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
        }
        @keyframes monadUiApprovalOut {
          0% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
          100% { opacity: 0; transform: translateY(10px) scale(.992); filter: blur(1px); }
        }
        @media (prefers-reduced-motion: reduce) {
          .monad-ui-approval-sheet,
          .monad-ui-approval-sheet.is-closing { animation: none; }
        }
      `}</style>

      <div style={{ alignItems: 'center', display: 'flex', gap: 10, justifyContent: 'space-between', minWidth: 0 }}>
        <div style={{ alignItems: 'center', display: 'flex', minWidth: 0 }}>{source}</div>
        {queueLabel ? (
          <span style={{ color: 'var(--muted-foreground)', flex: 'none', fontSize: 11 }}>{queueLabel}</span>
        ) : null}
      </div>

      <div
        style={{
          color: 'var(--foreground)',
          fontSize: 15,
          fontWeight: 600,
          lineHeight: 1.45,
          maxWidth: '72ch',
          overflowWrap: 'anywhere',
          textWrap: 'pretty'
        }}
      >
        {prompt}
      </div>

      {details ? (
        <div style={{ color: 'var(--muted-foreground)', fontSize: 12, lineHeight: 1.5, minWidth: 0 }}>{details}</div>
      ) : null}

      <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
        <Button
          className="h-8 gap-1.5 rounded-full px-3 text-[13px] text-foreground"
          onClick={deny}
          type="button"
          variant="outline"
        >
          {denyLabel}
          <kbd className="rounded bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground leading-none">
            Esc
          </kbd>
        </Button>
        <ButtonGroup>
          <Button
            className="h-8 gap-1.5 rounded-l-full bg-foreground px-3 text-[13px] text-background hover:bg-foreground/90"
            onClick={() => approve(primary.id)}
            type="button"
          >
            {primary.label}
            <kbd className="rounded bg-background/15 px-1.5 py-0.5 font-medium text-[10px] text-background leading-none">
              ↵
            </kbd>
          </Button>
          {secondary.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={moreOptionsLabel}
                  className="h-8 w-8 rounded-r-full border-l-background/20 bg-foreground px-0 text-background hover:bg-foreground/90"
                  type="button"
                >
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="size-3.5"
                    icon={ChevronDownIcon}
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
              >
                {secondary.map((option) => (
                  <DropdownMenuItem
                    key={option.id}
                    onSelect={() => approve(option.id)}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </ButtonGroup>
      </div>
    </fieldset>
  );
}
