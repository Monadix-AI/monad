'use client';

import type { HookEvent, SetHooksSettingsRequest } from '@monad/protocol';
import type { DraftCommand, DraftMatcher } from './hook-settings-types';

import { HOOK_EVENTS } from '@monad/protocol';
import { Button } from '@monad/ui';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell, PanelShellHeader } from '@/components/ui/panel-shell';
import { useHooksSettings } from '@/hooks/use-hooks-settings';
import { HookEditorDialog } from './HookEditorDialog';
import { HookFlow } from './HookFlow';

type DraftHooks = Record<HookEvent, DraftMatcher[]>;

let _nextId = 0;
const nextId = () => ++_nextId;

function newCommand(): DraftCommand {
  return { _id: nextId(), command: '' };
}
function newMatcher(): DraftMatcher {
  return { _id: nextId(), matcher: undefined, hooks: [newCommand()] };
}
function emptyDraft(): DraftHooks {
  return {
    SessionStart: [],
    BeforeTurn: [],
    BeforeModel: [],
    BeforeTool: [],
    ApprovalRequest: [],
    AfterTool: [],
    AfterModel: [],
    BeforeCompact: [],
    AfterCompact: [],
    BeforeSubagent: [],
    AfterSubagent: [],
    AfterTurn: [],
    SessionEnd: []
  };
}
function toDraft(
  raw: Record<
    string,
    { matcher?: string; hooks: { command: string; timeoutMs?: number; onError?: 'allow' | 'deny' }[] }[] | undefined
  >
): DraftHooks {
  const draft = emptyDraft();
  for (const event of HOOK_EVENTS) {
    draft[event] = (raw[event] ?? []).map((m) => ({
      _id: nextId(),
      matcher: m.matcher,
      hooks: m.hooks.map((h) => ({ _id: nextId(), command: h.command, timeoutMs: h.timeoutMs, onError: h.onError }))
    }));
  }
  return draft;
}

/** Empty (unset) is fine; a non-empty pattern that won't compile is flagged so the operator knows
 *  it will silently match nothing rather than wondering why their hook never fires. */
function matcherError(pattern: string | undefined): string | undefined {
  if (!pattern) return undefined;
  try {
    new RegExp(pattern);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid regular expression';
  }
}

export function HooksSettings(_props: { onClose: () => void }) {
  const { config, loading, save, refetch } = useHooksSettings();
  const t = useT();
  const [draft, setDraft] = useState<DraftHooks>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [editingEvent, setEditingEvent] = useState<HookEvent>();
  const loadedRef = useRef(false);
  const eventDescriptions = useMemo<Record<HookEvent, string>>(
    () => ({
      SessionStart: t('web.hooks.desc.SessionStart'),
      BeforeTurn: t('web.hooks.desc.BeforeTurn'),
      BeforeModel: t('web.hooks.desc.BeforeModel'),
      BeforeTool: t('web.hooks.desc.BeforeTool'),
      ApprovalRequest: t('web.hooks.desc.ApprovalRequest'),
      AfterTool: t('web.hooks.desc.AfterTool'),
      AfterModel: t('web.hooks.desc.AfterModel'),
      BeforeCompact: t('web.hooks.desc.BeforeCompact'),
      AfterCompact: t('web.hooks.desc.AfterCompact'),
      BeforeSubagent: t('web.hooks.desc.BeforeSubagent'),
      AfterSubagent: t('web.hooks.desc.AfterSubagent'),
      AfterTurn: t('web.hooks.desc.AfterTurn'),
      SessionEnd: t('web.hooks.desc.SessionEnd')
    }),
    [t]
  );

  useEffect(() => {
    if (!config || loadedRef.current) return;
    loadedRef.current = true;
    setDraft(toDraft(config.hooks));
  }, [config]);

  const updEvent = useCallback(
    (event: HookEvent, fn: (ms: DraftMatcher[]) => DraftMatcher[]) =>
      setDraft((prev) => ({ ...prev, [event]: fn(prev[event]) })),
    []
  );

  const addMatcher = useCallback((event: HookEvent) => updEvent(event, (ms) => [...ms, newMatcher()]), [updEvent]);

  const addMatcherAndEdit = useCallback(
    (event: HookEvent) => {
      addMatcher(event);
      setEditingEvent(event);
    },
    [addMatcher]
  );

  const removeMatcher = (event: HookEvent, id: number) => updEvent(event, (ms) => ms.filter((m) => m._id !== id));

  const updateMatcherFilter = (event: HookEvent, id: number, value: string) =>
    updEvent(event, (ms) => ms.map((m) => (m._id === id ? { ...m, matcher: value || undefined } : m)));

  const addCommand = (event: HookEvent, matcherId: number) =>
    updEvent(event, (ms) => ms.map((m) => (m._id === matcherId ? { ...m, hooks: [...m.hooks, newCommand()] } : m)));

  const removeCommand = (event: HookEvent, matcherId: number, cmdId: number) =>
    updEvent(event, (ms) =>
      ms.flatMap((m) => {
        if (m._id !== matcherId) return [m];
        const hooks = m.hooks.filter((h) => h._id !== cmdId);
        return hooks.length === 0 ? [] : [{ ...m, hooks }];
      })
    );

  const updateCommand = (
    event: HookEvent,
    matcherId: number,
    cmdId: number,
    field: 'command' | 'timeoutMs',
    value: string
  ) =>
    updEvent(event, (ms) =>
      ms.map((m) =>
        m._id !== matcherId
          ? m
          : {
              ...m,
              hooks: m.hooks.map((h) =>
                h._id !== cmdId
                  ? h
                  : field === 'command'
                    ? { ...h, command: value }
                    : { ...h, timeoutMs: value ? parseInt(value, 10) : undefined }
              )
            }
      )
    );

  const toggleFailClosed = (event: HookEvent, matcherId: number, cmdId: number) =>
    updEvent(event, (ms) =>
      ms.map((m) =>
        m._id !== matcherId
          ? m
          : {
              ...m,
              hooks: m.hooks.map((h) =>
                h._id !== cmdId ? h : { ...h, onError: h.onError === 'deny' ? undefined : 'deny' }
              )
            }
      )
    );

  const handleSave = async () => {
    setSaving(true);
    setSaveError(undefined);
    setSaved(false);
    try {
      const hooks: SetHooksSettingsRequest['hooks'] = {};
      for (const event of HOOK_EVENTS) {
        const matchers = draft[event]
          .map((m) => ({
            matcher: m.matcher,
            hooks: m.hooks
              .filter((h) => h.command.trim())
              .map((h) => ({
                command: h.command.trim(),
                timeoutMs: h.timeoutMs,
                onError: h.onError
              }))
          }))
          .filter((m) => m.hooks.length > 0);
        if (matchers.length > 0) hooks[event] = matchers;
      }
      await save({ hooks });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const hookFlowEvents = useMemo(
    () =>
      HOOK_EVENTS.map((event) => ({
        event,
        title: event,
        description: eventDescriptions[event],
        count: draft[event].reduce((total, matcher) => total + matcher.hooks.length, 0)
      })),
    [draft, eventDescriptions]
  );

  const editingMatchers = editingEvent ? draft[editingEvent] : [];

  return (
    <PanelShell>
      <PanelShellHeader
        actions={
          <Button
            aria-label={t('web.common.refresh')}
            className="size-7"
            onClick={refetch}
            size="icon"
            variant="ghost"
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
        }
        subtitle={t('web.hooks.subtitle')}
        title={t('web.settings.hooks')}
      />

      {loading ? (
        <div className="flex items-center gap-2 p-5 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t('web.common.loading')}
        </div>
      ) : (
        <>
          <HookFlow
            events={hookFlowEvents}
            onAdd={addMatcherAndEdit}
            t={t}
          />

          <div className="border-t px-5 py-3">
            <div className="flex items-center gap-3">
              <Button
                disabled={saving}
                onClick={() => void handleSave()}
                size="sm"
              >
                {saving ? <Loader2 className="animate-spin" /> : saved ? <Check /> : null}
                {saving ? t('web.common.saving') : saved ? t('web.common.saved') : t('web.common.save')}
              </Button>
              {saveError && <span className="text-destructive text-xs">{saveError}</span>}
            </div>
          </div>
        </>
      )}

      {editingEvent && (
        <HookEditorDialog
          description={eventDescriptions[editingEvent]}
          event={editingEvent}
          matcherError={matcherError}
          matchers={editingMatchers}
          onAddCommand={addCommand}
          onAddMatcher={addMatcher}
          onClose={() => setEditingEvent(undefined)}
          onRemoveCommand={removeCommand}
          onRemoveMatcher={removeMatcher}
          onToggleFailClosed={toggleFailClosed}
          onUpdateCommand={updateCommand}
          onUpdateMatcherFilter={updateMatcherFilter}
          t={t}
        />
      )}
    </PanelShell>
  );
}
