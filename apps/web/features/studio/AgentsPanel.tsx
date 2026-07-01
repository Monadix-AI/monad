'use client';

import type { Agent, AgentId } from '@monad/protocol';

import { useCreateAgentMutation, useDeleteAgentMutation, useListAgentsQuery } from '@monad/client-rtk';
import { Badge, Button, ScrollArea, Textarea } from '@monad/ui';
import { Bot, Check, Loader2, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell } from '@/components/ui/panel-shell';
import { studioDetailPath, studioSubpathFromPathname } from '@/features/routes/route-paths';
import { parseClaudeSubagent } from '@/lib/parse-agent-import';
import { AgentEditor } from './agent-workshop/AgentEditor';
import { StudioBreadcrumbHeader } from './StudioBreadcrumbHeader';

/** Agents area of Studio: a master list of agents ↔ a single-agent editor. */
export function AgentsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const pathname = usePathname();
  const router = useRouter();
  const { data, isLoading, refetch, isFetching } = useListAgentsQuery();
  const [createAgent, { isLoading: creating }] = useCreateAgentMutation();
  const [deleteAgent] = useDeleteAgentMutation();
  const [confirmDelete, setConfirmDelete] = useState<AgentId | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string>();

  const agents = data?.agents ?? [];
  const editing = (studioSubpathFromPathname(pathname)[0] as AgentId | undefined) ?? null;

  // Surface duplicate names so the user resolves them (we never silently shadow).
  const dupNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of agents) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
  }, [agents]);

  if (editing) {
    return (
      <AgentEditor
        agentId={editing}
        onClose={onClose}
      />
    );
  }

  const handleCreate = async () => {
    const res = await createAgent({ name: t('web.studio.newAgentName'), capabilities: [] }).unwrap();
    router.replace(studioDetailPath('agents', res.agent.id));
  };

  const handleImport = async () => {
    setImportError(undefined);
    let parsed: ReturnType<typeof parseClaudeSubagent>;
    try {
      parsed = parseClaudeSubagent(importText);
    } catch (e) {
      setImportError((e as Error).message);
      return;
    }
    try {
      const res = await createAgent({
        name: parsed.name,
        description: parsed.description,
        model: parsed.model,
        prompt: parsed.prompt,
        capabilities: []
      }).unwrap();
      setImporting(false);
      setImportText('');
      router.replace(studioDetailPath('agents', res.agent.id));
    } catch (e) {
      setImportError((e as { message?: string }).message ?? 'Failed to create agent');
    }
  };

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        actions={
          <>
            <Button
              aria-label={t('web.common.refresh')}
              onClick={() => void refetch()}
              size="icon"
              variant="ghost"
            >
              <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
            </Button>
            <Button
              onClick={() => {
                setImporting((v) => !v);
                setImportError(undefined);
              }}
              size="sm"
              variant="ghost"
            >
              <Upload />
              {t('web.studio.import')}
            </Button>
            <Button
              disabled={creating}
              onClick={() => void handleCreate()}
              size="sm"
              variant="outline"
            >
              {creating ? <Loader2 className="animate-spin" /> : <Plus />}
              {t('web.studio.newAgent')}
            </Button>
          </>
        }
        icon={<Bot className="size-4" />}
        title={t('web.studio.agents')}
      />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-5">
          {importing && (
            <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
              <div className="flex items-center gap-2">
                <Upload className="size-4 text-muted-foreground" />
                <span className="font-medium text-sm">{t('web.studio.importTitle')}</span>
              </div>
              <p className="text-muted-foreground text-xs">{t('web.studio.importHint')}</p>
              <Textarea
                className="min-h-40 font-mono text-[13px]"
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'---\nname: code-reviewer\ndescription: ...\n---\nYou are ...'}
                value={importText}
              />
              {importError && <p className="text-destructive text-xs">{importError}</p>}
              <div className="flex items-center gap-2">
                <Button
                  disabled={creating || !importText.trim()}
                  onClick={() => void handleImport()}
                  size="sm"
                >
                  {creating ? <Loader2 className="animate-spin" /> : <Upload />}
                  {t('web.studio.import')}
                </Button>
                <Button
                  onClick={() => {
                    setImporting(false);
                    setImportError(undefined);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {t('web.common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}

          {!isLoading && agents.length === 0 && (
            <div className="mx-auto flex max-w-xs flex-col items-center gap-3 py-16 text-center">
              <Bot className="size-8 text-muted-foreground/60" />
              <p className="font-medium text-sm">{t('web.studio.emptyTitle')}</p>
              <p className="text-muted-foreground text-sm">{t('web.studio.emptyBody')}</p>
              <Button
                disabled={creating}
                onClick={() => void handleCreate()}
                size="sm"
              >
                <Plus />
                {t('web.studio.createFirst')}
              </Button>
            </div>
          )}

          {agents.map((a: Agent) => (
            <div
              className="flex items-start gap-2 rounded-lg border bg-card px-4 py-3 transition-colors hover:border-ring/40 hover:bg-accent"
              key={a.id}
            >
              <button
                className="flex min-w-0 flex-1 flex-col items-stretch gap-1.5 text-left"
                onClick={() => router.replace(studioDetailPath('agents', a.id))}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium text-sm">{a.name}</span>
                  {dupNames.has(a.name) && (
                    <Badge
                      className="border-destructive/40 bg-destructive/10 text-destructive"
                      variant="outline"
                    >
                      {t('web.studio.duplicateName')}
                    </Badge>
                  )}
                  {a.visibility?.subagentCallable && <Badge variant="secondary">{t('web.studio.badgeSubagent')}</Badge>}
                  {a.visibility?.public && <Badge variant="secondary">{t('web.studio.badgePublic')}</Badge>}
                </span>
                {a.description && <span className="line-clamp-2 text-muted-foreground text-xs">{a.description}</span>}
                <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-mono">{a.model ?? a.modelAlias ?? t('web.studio.modelInherit')}</span>
                  {a.hasPrompt && <span>· {t('web.studio.hasPrompt')}</span>}
                  {a.sandboxMode && <span>· {a.sandboxMode}</span>}
                </span>
              </button>
              <span className="flex items-center gap-1">
                {confirmDelete === a.id ? (
                  <>
                    <Button
                      aria-label={t('web.common.confirm')}
                      className="size-6 text-destructive"
                      onClick={() => {
                        void deleteAgent(a.id);
                        setConfirmDelete(null);
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      <Check className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={t('web.common.cancel')}
                      className="size-6"
                      onClick={() => setConfirmDelete(null)}
                      size="icon"
                      variant="ghost"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <Button
                    aria-label={t('web.common.delete')}
                    className="size-6"
                    onClick={() => setConfirmDelete(a.id)}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}
