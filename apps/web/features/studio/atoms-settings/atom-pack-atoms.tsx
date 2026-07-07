import type { AtomDescriptor, AtomKind } from '@monad/protocol';

import {
  BotIcon,
  BrainIcon,
  LanguageSquareIcon,
  MessageMultiple01Icon,
  MessageSquareCodeIcon,
  PackageIcon,
  Plug01Icon,
  PuzzleIcon,
  ServerStack01Icon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
  WorkflowSquare01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge, cn } from '@monad/ui';
import { Fragment } from 'react';

import { providerLogo, useProviderMeta } from '@/lib/ProviderMeta';

type AtomForm = 'chips' | 'command' | 'detail';
type KindMeta = { label: string; icon: typeof PackageIcon; blurb: string; form: AtomForm };

const KIND_META: Record<AtomKind, KindMeta> = {
  skill: {
    label: 'Skills',
    icon: SparklesIcon,
    blurb: 'Portable capability packets the agent loads on demand.',
    form: 'detail'
  },
  command: {
    label: 'Commands',
    icon: TerminalIcon,
    blurb: 'Slash commands available across every client.',
    form: 'command'
  },
  mcp: {
    label: 'MCP servers',
    icon: ServerStack01Icon,
    blurb: 'Model Context Protocol servers exposing external tools.',
    form: 'detail'
  },
  provider: {
    label: 'Model providers',
    icon: BrainIcon,
    blurb: 'Upstream gateways the model router can send requests to.',
    form: 'detail'
  },
  channel: {
    label: 'Channels',
    icon: MessageMultiple01Icon,
    blurb: 'Inbound chat gateways that route messages into sessions.',
    form: 'detail'
  },
  connector: {
    label: 'Connectors',
    icon: Plug01Icon,
    blurb: 'Webhook and integration endpoints.',
    form: 'detail'
  },
  'agent-adapter': {
    label: 'Agent adapters',
    icon: BotIcon,
    blurb: 'External agent agents managed as workplace members.',
    form: 'detail'
  },
  hook: {
    label: 'Hooks',
    icon: WorkflowSquare01Icon,
    blurb: 'Lifecycle handlers that run on daemon events.',
    form: 'detail'
  },
  sandbox: {
    label: 'Sandboxes',
    icon: ShieldIcon,
    blurb: 'OS-level confinement backends for tool execution.',
    form: 'detail'
  },
  'message-type': {
    label: 'Message types',
    icon: MessageSquareCodeIcon,
    blurb: 'Custom transcript payload renderers.',
    form: 'detail'
  },
  'workspace-experience': {
    label: 'Workspace experiences',
    icon: PuzzleIcon,
    blurb: 'Embedded UI surfaces mounted inside the workspace.',
    form: 'detail'
  },
  locale: {
    label: 'Locales',
    icon: LanguageSquareIcon,
    blurb: 'Language packs for the CLI, TUI, and web UI.',
    form: 'chips'
  }
};

const KIND_ORDER = Object.keys(KIND_META) as AtomKind[];

export function AtomPackAtoms({ atoms }: { atoms: AtomDescriptor[] }) {
  const byKind = new Map<AtomKind, AtomDescriptor[]>();
  for (const atom of atoms) {
    const list = byKind.get(atom.kind) ?? [];
    list.push(atom);
    byKind.set(atom.kind, list);
  }
  const groups = [...byKind.entries()].sort(([a], [b]) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));

  return (
    <div className="flex flex-col gap-3.5 border-t px-3 py-3">
      {groups.map(([kind, list]) => {
        const meta = KIND_META[kind];
        return (
          <section
            className="flex flex-col gap-2"
            key={kind}
          >
            <header className="flex items-start gap-2.5">
              <div className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                <HugeiconsIcon
                  className="size-3.5"
                  icon={meta?.icon ?? PackageIcon}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-baseline gap-1.5">
                  <h4 className="font-medium text-foreground text-xs">{meta?.label ?? kind}</h4>
                  <span className="text-[10px] text-muted-foreground/50 tabular-nums">{list.length}</span>
                </div>
                {meta?.blurb ? (
                  <p className="text-[10.5px] text-muted-foreground/60 leading-snug">{meta.blurb}</p>
                ) : null}
              </div>
            </header>
            <div className="pl-[34px]">
              <AtomKindBody
                atoms={list}
                form={meta?.form ?? 'detail'}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}

function providerHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function ProviderMark({ id, className }: { id: string; className?: string }) {
  const { logo: Logo, color } = providerLogo(id);
  return (
    <span className={cn('grid shrink-0 place-items-center rounded-md border bg-card', className)}>
      <Logo className={cn('size-4', color)} />
    </span>
  );
}

function AtomKindBody({ atoms, form }: { atoms: AtomDescriptor[]; form: AtomForm }) {
  const { metaFor } = useProviderMeta();
  const isProvider = atoms[0]?.kind === 'provider';

  if (form === 'chips') {
    return (
      <div className="flex flex-wrap gap-1">
        {atoms.map((atom) => (
          <Badge
            className="font-mono text-[10px]"
            key={atom.id}
            title={atom.name ?? atom.description}
            variant="outline"
          >
            {atom.id}
          </Badge>
        ))}
      </div>
    );
  }

  if (form === 'command') {
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5">
        {atoms.map((atom) => (
          <Fragment key={atom.id}>
            <dt className="whitespace-nowrap font-mono text-[color:var(--link)] text-xs">/{atom.id}</dt>
            <dd className="min-w-0 truncate text-[11px] text-muted-foreground/80">
              {atom.description ?? atom.name ?? ''}
            </dd>
          </Fragment>
        ))}
      </dl>
    );
  }

  if (isProvider) {
    return (
      <ul className="pv-table">
        {atoms.map((atom) => {
          const meta = metaFor(atom.id);
          const host = providerHost(meta.defaultBaseUrl);
          return (
            <li
              className="pv-trow"
              key={atom.id}
            >
              <span className="pv-cell">
                <ProviderMark
                  className="pv-mark"
                  id={atom.id}
                />
              </span>
              <span className="pv-name">{atom.name ?? atom.id}</span>
              <code className="pv-id">{atom.id}</code>
              <span className="pv-strategy">{meta.strategy === 'native' ? 'Native' : 'OpenAI-compat'}</span>
              <span className="pv-host">{host ?? ''}</span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {atoms.map((atom) => (
        <li
          className="flex flex-col gap-0.5"
          key={atom.id}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-mono text-foreground/90 text-xs">{atom.id}</span>
            {atom.name ? <span className="truncate text-[11px] text-muted-foreground">{atom.name}</span> : null}
          </div>
          {atom.description ? (
            <span className="text-[11px] text-muted-foreground/70 leading-snug">{atom.description}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
