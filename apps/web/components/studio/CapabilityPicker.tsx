'use client';

import { mcpServerAdapter, mcpServerSelectors, useListAtomPacksQuery, useListMcpServersQuery } from '@monad/client-rtk';
import { Switch } from '@monad/ui';
import { Atom, Plug, ShieldHalf } from 'lucide-react';

import { useT } from '@/components/I18nProvider';

interface Props {
  mode: 'inherit' | 'allowlist';
  allow: string[];
  onModeChange: (mode: 'inherit' | 'allowlist') => void;
  onToggle: (name: string, on: boolean) => void;
}

/** Agent-editor tab: select which system-registered atoms/MCP this agent may use (its `atoms.allow`).
 *  Exposure ⊆ registration — the list comes from the same Capabilities queries; an agent can only
 *  narrow to what's already installed. */
export function CapabilityPicker({ mode, allow, onModeChange, onToggle }: Props) {
  const t = useT();
  const { data: atomData } = useListAtomPacksQuery();
  const mcpQ = useListMcpServersQuery();
  const packs = (atomData?.atomPacks ?? []).filter((p) => p.enabled);
  const servers = mcpServerSelectors.selectAll(mcpQ.data ?? mcpServerAdapter.getInitialState());
  const allowed = new Set(allow);
  const empty = packs.length === 0 && servers.length === 0;

  const row = (kind: 'atom' | 'mcp', name: string, hint?: string) => (
    <div
      className="flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2"
      key={`${kind}:${name}`}
    >
      {kind === 'atom' ? (
        <Atom className="size-4 text-muted-foreground" />
      ) : (
        <Plug className="size-4 text-muted-foreground" />
      )}
      <span className="font-medium text-sm">{name}</span>
      {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
      <span className="ml-auto">
        <Switch
          checked={allowed.has(name)}
          onCheckedChange={(on) => onToggle(name, on)}
        />
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3">
        <div className="flex-1">
          <p className="font-medium text-sm">{t('web.studio.atomsAllowlist')}</p>
          <p className="text-muted-foreground text-xs">{t('web.studio.atomsModeDesc')}</p>
        </div>
        <Switch
          checked={mode === 'allowlist'}
          onCheckedChange={(on) => onModeChange(on ? 'allowlist' : 'inherit')}
        />
      </div>

      {mode === 'allowlist' &&
        (empty ? (
          <p className="rounded-md border border-dashed px-4 py-6 text-center text-muted-foreground text-xs">
            {t('web.studio.atomsEmpty')}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {packs.map((p) => row('atom', p.name, p.atoms.join(', ')))}
            {servers.map((s) => row('mcp', s.name))}
          </div>
        ))}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ShieldHalf className="size-3.5 text-primary" />
        {t('web.studio.exposeSubset')}
      </p>
    </div>
  );
}
