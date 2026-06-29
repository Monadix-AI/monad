'use client';

import type { MemoryScopeQuery, QdrantPhase, ScopeKind } from '@monad/protocol';
import type { LucideIcon } from 'lucide-react';

import {
  skipToken,
  useAddMemoryFactMutation,
  useForgetMemoryFactMutation,
  useGetMemoryCoreQuery,
  useGetMemoryStatusQuery,
  useListMemoryFactsQuery,
  usePutMemoryCoreMutation,
  useSetMem0ModelsMutation,
  useSetMemoryBackendMutation,
  useSetMemoryGraphMutation
} from '@monad/client-rtk';
import {
  Badge,
  Button,
  cn,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  Textarea
} from '@monad/ui';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Cloud,
  Database,
  HardDrive,
  Loader2,
  Network,
  Plus,
  ShieldOff,
  Trash2
} from 'lucide-react';
import { useState } from 'react';

import { type TFn, useT } from '@/components/I18nProvider';
import { useModelSettings } from '@/hooks/use-model-settings';
import { GraphView } from './GraphView';
import { Mem0Explorer } from './Mem0Explorer';
import { StudioPanel, StudioPanelHeader } from './studio/StudioPanel';

// The Memory panel folds three formerly-separate Studio sections into one: configuration (this tab,
// incl. mem0 backend + the L2 graph settings), the read-only graph view, and the mem0 explorer.
export type MemoryTab = 'settings' | 'graph' | 'mem0';

interface Props {
  onClose: () => void;
  initialTab?: MemoryTab;
}

const DEFAULT_GRAPH_INTERVAL = 30;

const DEFAULT_LLM = '__default__';
const DEFAULT_EMBED = '__embedding_role__';

// A compact two-or-three-way pill toggle — the panel's primary affordance for mutually-exclusive
// choices (backend, scope). The active segment sits raised on the surface; the rest recede.
function Segmented<T extends string>({
  options,
  value,
  onChange
}: {
  options: { value: T; label: string; icon?: LucideIcon }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/50 p-0.5">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-sm transition-colors',
              active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
            key={o.value}
            onClick={() => onChange(o.value)}
            type="button"
          >
            {o.icon ? <o.icon className="size-4" /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function QdrantStatus({ phase, error, t }: { phase: QdrantPhase; error: string | null; t: TFn }) {
  const busy = phase === 'downloading' || phase === 'launching';
  return (
    <div className="flex items-start gap-2">
      {busy ? (
        <Loader2 className="mt-px size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <div
          className={cn('mt-1 size-2 shrink-0 rounded-full', {
            'bg-muted-foreground/40': phase === 'idle',
            'bg-green-500': phase === 'ready',
            'bg-destructive': phase === 'failed'
          })}
        />
      )}
      <span className={cn('text-xs', phase === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
        {phase === 'idle' && t('web.memory.qdrantIdle')}
        {phase === 'downloading' && t('web.memory.qdrantDownloading')}
        {phase === 'launching' && t('web.memory.qdrantLaunching')}
        {phase === 'ready' && t('web.memory.qdrantReady')}
        {phase === 'failed' && t('web.memory.qdrantFailed', { error: error ?? 'failed to start' })}
      </span>
    </div>
  );
}

// Memory panel: pick the L1 backend, configure mem0's models (chosen from Monad's model registry),
// and browse/add/forget per-scope facts (with a raw MEMORY.md editor for the built-in backend).
export function MemorySettings({ initialTab = 'settings' }: Props) {
  const t = useT();
  const [tab, setTab] = useState<MemoryTab>(initialTab);
  const SCOPES: { value: ScopeKind; label: string }[] = [
    { value: 'global', label: t('web.memory.scopeGlobal') },
    { value: 'agent', label: t('web.memory.scopeAgent') },
    { value: 'session', label: t('web.memory.scopeSession') }
  ];
  const [scopeKind, setScopeKind] = useState<ScopeKind>('global');
  const [scopeId, setScopeId] = useState('');
  const [draft, setDraft] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [intervalDraft, setIntervalDraft] = useState<string | null>(null);

  // global is the single shared user scope ('*'); agent/session need an id before we can query.
  // Free-text agt_…/ses_… input; the daemon validates it (assertSafeScopeId / the wire schema).
  const effectiveId = (scopeKind === 'global' ? '*' : scopeId.trim()) as MemoryScopeQuery['scopeId'];
  const ready = scopeKind === 'global' || effectiveId.length > 0;
  const query = ready ? { scopeKind, scopeId: effectiveId } : skipToken;

  // Poll only while the Settings tab is open, to catch qdrant download/launch transitions in real
  // time. The Graph/mem0 tabs don't render status, so they poll their own data instead (no status churn).
  const { data: status } = useGetMemoryStatusQuery(undefined, {
    pollingInterval: tab === 'settings' ? 2000 : 0
  });
  const isMem0 = (status?.backend ?? 'builtin') === 'mem0';
  const mem0 = status?.mem0;
  const qdrant = status?.qdrant;
  const { profiles } = useModelSettings();

  const [setMemoryBackend] = useSetMemoryBackendMutation();
  const [setMem0Models] = useSetMem0ModelsMutation();
  const [setMemoryGraph] = useSetMemoryGraphMutation();
  const { data: facts = [] } = useListMemoryFactsQuery(query);
  const { data: core } = useGetMemoryCoreQuery(
    rawOpen && ready && !isMem0 ? { scopeKind, scopeId: effectiveId } : skipToken
  );
  const [addFact, { isLoading: adding }] = useAddMemoryFactMutation();
  const [forgetFact] = useForgetMemoryFactMutation();
  const [putCore, { isLoading: saving }] = usePutMemoryCoreMutation();

  const submitAdd = () => {
    const content = draft.trim();
    if (!content || !ready) return;
    void addFact({ scopeKind, scopeId: effectiveId, content }).then(() => setDraft(''));
  };

  const rawValue = rawDraft ?? core?.core ?? '';

  // L2 graph consolidation settings (null in status ⇒ unset → off / default interval).
  const graphAuto = status?.graph?.autoConsolidate ?? false;
  const graphInterval = status?.graph?.intervalMinutes ?? DEFAULT_GRAPH_INTERVAL;
  const intervalValue = intervalDraft ?? String(graphInterval);
  const commitInterval = () => {
    if (intervalDraft === null) return;
    const n = Number.parseInt(intervalDraft, 10);
    if (Number.isFinite(n) && n > 0 && n !== graphInterval) void setMemoryGraph({ intervalMinutes: n });
    setIntervalDraft(null);
  };

  const TABS: { value: MemoryTab; label: string; icon: LucideIcon }[] = [
    { value: 'settings', label: t('web.memory.tabSettings'), icon: Brain },
    { value: 'graph', label: t('web.settings.graph'), icon: Network },
    { value: 'mem0', label: t('web.settings.mem0'), icon: Database }
  ];

  return (
    <StudioPanel>
      <StudioPanelHeader
        actions={
          <Segmented
            onChange={setTab}
            options={TABS}
            value={tab}
          />
        }
        icon={<Brain className="size-4 text-muted-foreground" />}
        title={t('web.settings.memory')}
      />

      {tab === 'graph' ? (
        <GraphView />
      ) : tab === 'mem0' ? (
        <Mem0Explorer />
      ) : (
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
          {/* Backend */}
          <section className="flex flex-col gap-3">
            <div>
              <Label className="text-sm">{t('web.memory.backendLabel')}</Label>
              <p className="mt-1 max-w-prose text-muted-foreground text-sm">{t('web.memory.backendDesc')}</p>
            </div>
            <Segmented
              onChange={(v) => void setMemoryBackend({ backend: v })}
              options={[
                { value: 'builtin', label: t('web.memory.builtin'), icon: HardDrive },
                { value: 'mem0', label: 'mem0', icon: Cloud }
              ]}
              value={isMem0 ? 'mem0' : 'builtin'}
            />

            {isMem0 ? (
              <div className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4">
                <p className="flex items-start gap-2 text-muted-foreground text-xs">
                  <ShieldOff className="mt-px size-3.5 shrink-0" />
                  <span>{t('web.memory.mem0Automatic')}</span>
                </p>

                <p className="text-muted-foreground text-xs">{t('web.memory.mem0Profiles')}</p>

                {qdrant ? (
                  <QdrantStatus
                    error={qdrant.error}
                    phase={qdrant.phase}
                    t={t}
                  />
                ) : (
                  <p className="text-muted-foreground text-xs">
                    {t('web.memory.qdrantLocal')} <code className="font-mono">memory.mem0.vectorStore</code>{' '}
                    {t('web.memory.qdrantConfigJoin')} <code className="font-mono">config.json</code>.
                  </p>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>{t('web.memory.extractModel')}</Label>
                    <Select
                      onValueChange={(v) => void setMem0Models({ llm: v === DEFAULT_LLM ? null : v })}
                      value={mem0?.llm ?? DEFAULT_LLM}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_LLM}>{t('web.memory.chatDefault')}</SelectItem>
                        {profiles.map((p) => (
                          <SelectItem
                            key={p.alias}
                            value={p.alias}
                          >
                            {p.alias}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>{t('web.memory.embedModel')}</Label>
                    <Select
                      onValueChange={(v) => void setMem0Models({ embedder: v === DEFAULT_EMBED ? null : v })}
                      value={mem0?.embedder ?? DEFAULT_EMBED}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_EMBED}>{t('web.memory.embedRole')}</SelectItem>
                        {profiles.map((p) => (
                          <SelectItem
                            key={p.alias}
                            value={p.alias}
                          >
                            {p.alias}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {mem0?.error ? (
                  <div className="flex items-start gap-2">
                    <Badge variant="destructive">{t('web.memory.statusUnresolved')}</Badge>
                    <p className="text-destructive text-xs">{mem0.error}</p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{t('web.memory.statusReady')}</Badge>
                    <p className="text-muted-foreground text-xs">
                      {t('web.memory.embedDim', { dim: mem0?.embedDim ?? '—' })}
                    </p>
                  </div>
                )}
              </div>
            ) : null}
          </section>

          <Separator />

          {/* Knowledge graph (L2) */}
          <section className="flex flex-col gap-3">
            <div>
              <Label className="text-sm">{t('web.memory.graphLabel')}</Label>
              <p className="mt-1 max-w-prose text-muted-foreground text-sm">{t('web.memory.graphDesc')}</p>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div className="min-w-0">
                <Label className="text-sm">{t('web.memory.graphAuto')}</Label>
                <p className="mt-0.5 text-muted-foreground text-xs">{t('web.memory.graphAutoDesc')}</p>
              </div>
              <Switch
                aria-label={t('web.memory.graphAuto')}
                checked={graphAuto}
                onCheckedChange={(v) => void setMemoryGraph({ autoConsolidate: v })}
              />
            </div>
            {graphAuto ? (
              <div className="flex max-w-xs flex-col gap-1.5">
                <Label>{t('web.memory.graphInterval')}</Label>
                <Input
                  className="h-9"
                  min={1}
                  onBlur={commitInterval}
                  onChange={(e) => setIntervalDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitInterval();
                  }}
                  type="number"
                  value={intervalValue}
                />
              </div>
            ) : null}
          </section>

          <Separator />

          {/* Facts */}
          <section className="flex flex-col gap-3">
            <div>
              <Label className="text-sm">{t('web.memory.factsLabel')}</Label>
              <p className="mt-1 max-w-prose text-muted-foreground text-sm">{t('web.memory.factsDesc')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                onChange={(v) => {
                  setScopeKind(v);
                  setRawDraft(null);
                  setRawOpen(false);
                }}
                options={SCOPES}
                value={scopeKind}
              />
              {scopeKind !== 'global' ? (
                <Input
                  className="h-8 w-56 font-mono text-xs"
                  onChange={(e) => setScopeId(e.target.value)}
                  placeholder={scopeKind === 'agent' ? 'agt_…' : 'ses_…'}
                  value={scopeId}
                />
              ) : null}
            </div>

            {ready ? (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    className="h-9"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitAdd();
                    }}
                    placeholder={t('web.memory.factPlaceholder')}
                    value={draft}
                  />
                  <Button
                    disabled={adding || !draft.trim()}
                    onClick={submitAdd}
                    size="sm"
                  >
                    <Plus className="size-4" /> {t('web.memory.factAdd')}
                  </Button>
                </div>

                {facts.length === 0 ? (
                  <div className="rounded-lg border border-dashed py-10 text-center">
                    <p className="text-muted-foreground text-sm">{t('web.memory.noFacts')}</p>
                    <p className="mt-1 text-muted-foreground/70 text-xs">{t('web.memory.noFactsHint')}</p>
                  </div>
                ) : (
                  <ul className="flex flex-col divide-y rounded-lg border">
                    {facts.map((f) => (
                      <li
                        className="group flex items-center justify-between gap-3 px-3 py-2.5"
                        key={f.id}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{f.content}</span>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge
                            className="font-normal"
                            variant={f.provClass === 'user' ? 'secondary' : 'outline'}
                          >
                            {f.provClass === 'user' ? 'you' : 'auto'}
                          </Badge>
                          <Button
                            aria-label={t('web.memory.ariaForget')}
                            className="size-7 text-muted-foreground opacity-60 transition-opacity hover:text-destructive group-hover:opacity-100"
                            onClick={() => void forgetFact({ scopeKind, scopeId: effectiveId, id: f.id })}
                            size="icon"
                            variant="ghost"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {!isMem0 ? (
                  <div>
                    <button
                      className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                      onClick={() => setRawOpen((v) => !v)}
                      type="button"
                    >
                      {rawOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      {t('web.memory.editRaw')}
                    </button>
                    {rawOpen ? (
                      <div className="mt-2 flex flex-col gap-2">
                        <Textarea
                          className="min-h-48 font-mono text-xs"
                          onChange={(e) => setRawDraft(e.target.value)}
                          value={rawValue}
                        />
                        <div className="flex justify-end">
                          <Button
                            disabled={saving || rawDraft === null}
                            onClick={() =>
                              void putCore({ scopeKind, scopeId: effectiveId, core: rawValue }).then(() =>
                                setRawDraft(null)
                              )
                            }
                            size="sm"
                          >
                            {t('web.common.save')}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="rounded-lg border border-dashed py-10 text-center">
                <p className="text-muted-foreground text-sm">
                  {scopeKind === 'agent' ? t('web.memory.enterScopeAgent') : t('web.memory.enterScopeSession')}
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </StudioPanel>
  );
}
