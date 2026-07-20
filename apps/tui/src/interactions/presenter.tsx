import type { MonadClient } from '@monad/client';
import type {
  InteractionEvent,
  InteractionField,
  InteractionPresenterCapabilities,
  InteractionSource,
  PendingInteraction
} from '@monad/protocol';

import { pendingInteractionSchema } from '@monad/protocol';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';

import { TUI_GLYPHS, TUI_THEME } from '../components/theme.ts';

const TUI_CAPABILITIES: InteractionPresenterCapabilities = {
  interactionTypes: ['confirm', 'select', 'form'],
  fieldTypes: ['string', 'secret', 'number', 'boolean', 'select'],
  supportsSecretInput: true,
  supportsBackgroundQueue: true
};
const claimedInteractionSchema = z.object({ interaction: pendingInteractionSchema, leaseToken: z.string().min(1) });

type ClaimedInteraction = { interaction: PendingInteraction; leaseToken: string };
type CancellationReason = 'close' | 'escape' | 'timeout' | 'disconnect' | 'unavailable';

export function interactionSourceLabel(source: InteractionSource): string {
  return source.kind === 'builtin' ? (source.label ?? source.id) : `${source.packId} / ${source.atomId}`;
}

export function summarizeInteractionValue(field: InteractionField, value: unknown): string {
  if (value === '' || value === undefined || value === null) return '(empty)';
  if (field.type === 'secret') return '********';
  if (field.type === 'boolean') return value ? 'yes' : 'no';
  if (field.type === 'select') {
    return field.options.find((option) => option.value === value)?.label ?? String(value);
  }
  return String(value);
}

function initialValues(interaction: PendingInteraction): Record<string, unknown> {
  const { request } = interaction;
  if (request.type === 'confirm') return { confirmed: false };
  if (request.type === 'select') return { value: request.options[0]?.value ?? '' };
  return Object.fromEntries(
    request.fields.map((field) => {
      if (field.type === 'secret') return [field.id, ''];
      if (field.type === 'select') return [field.id, field.defaultValue ?? field.options[0]?.value ?? ''];
      return [field.id, field.defaultValue ?? (field.type === 'boolean' ? false : '')];
    })
  );
}

function formValue(field: InteractionField, raw: unknown): unknown {
  if (field.type !== 'number' || raw === '') return raw;
  return Number(raw);
}

export function useTuiInteractionPresenter(client: MonadClient) {
  const presenterId = useRef(`tui-${crypto.randomUUID()}`);
  const claiming = useRef(false);
  const activeRef = useRef<ClaimedInteraction | null>(null);
  const pendingRef = useRef(new Map<string, PendingInteraction>());
  const drainRef = useRef<() => void>(() => {});
  const [active, setActive] = useState<ClaimedInteraction | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fieldIndex, setFieldIndex] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    const drain = () => {
      if (disposed || claiming.current || activeRef.current) return;
      const candidate = [...pendingRef.current.values()].find(
        (item) => item.mode === 'foreground' && item.state === 'pending'
      );
      if (!candidate) return;
      pendingRef.current.delete(candidate.id);
      void claim(candidate);
    };
    const claim = async (candidate: PendingInteraction) => {
      if (claiming.current || activeRef.current || candidate.mode !== 'foreground' || candidate.state !== 'pending')
        return;
      try {
        claiming.current = true;
        const claimResponse = await client.fetch(`/v1/interactions/${encodeURIComponent(candidate.id)}/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ presenterId: presenterId.current, capabilities: TUI_CAPABILITIES })
        });
        if (!claimResponse.ok || disposed) return;
        const claimed: ClaimedInteraction = claimedInteractionSchema.parse(await claimResponse.json());
        activeRef.current = claimed;
        setActive(claimed);
        setValues(initialValues(candidate));
        setFieldIndex(0);
        setError(undefined);
      } catch {
        // Connection state is rendered by the main TUI; presenter polling remains quiet.
      } finally {
        claiming.current = false;
        drain();
      }
    };
    drainRef.current = drain;
    const onEvent = (event: InteractionEvent) => {
      if (event.type === 'removed') {
        pendingRef.current.delete(event.id);
        if (activeRef.current?.interaction.id === event.id) {
          activeRef.current = null;
          setActive(null);
          drain();
        }
        return;
      }
      pendingRef.current.set(event.interaction.id, event.interaction);
      drain();
    };
    const dispose = client.streamInteractionEvents(onEvent);
    return () => {
      disposed = true;
      drainRef.current = () => {};
      dispose();
      void client.fetch(`/v1/interactions/presenters/${encodeURIComponent(presenterId.current)}/release`, {
        method: 'POST'
      });
    };
  }, [client]);

  useEffect(() => {
    if (!active) return;
    const renew = () =>
      client.fetch(`/v1/interactions/${encodeURIComponent(active.interaction.id)}/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaseToken: active.leaseToken })
      });
    const timer = setInterval(() => void renew(), 10_000);
    return () => clearInterval(timer);
  }, [active, client]);

  const complete = async (action: 'submit' | 'cancel', body: Record<string, unknown>) => {
    const current = activeRef.current;
    if (!current) return;
    const response = await client.fetch(`/v1/interactions/${encodeURIComponent(current.interaction.id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaseToken: current.leaseToken, ...body })
    });
    if (!response.ok) {
      setError(`interaction ${action} failed (${response.status})`);
      return;
    }
    activeRef.current = null;
    setActive(null);
    drainRef.current();
  };

  return {
    active,
    values,
    fieldIndex,
    error,
    setFieldIndex,
    setValues,
    submit: (submittedValues: Record<string, unknown> = values) => complete('submit', { values: submittedValues }),
    cancel: (reason: CancellationReason) => complete('cancel', { reason })
  };
}

type Presenter = ReturnType<typeof useTuiInteractionPresenter>;

function cycle(current: string, options: Array<{ value: string }>, delta: number): string {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === current)
  );
  return options[(index + delta + options.length) % options.length]?.value ?? '';
}

export function HostInteractionPrompt({ presenter }: { presenter: Presenter }) {
  const interaction = presenter.active?.interaction;
  const request = interaction?.request;
  const field = request?.type === 'form' ? request.fields[presenter.fieldIndex] : undefined;

  const advance = (nextValues = presenter.values) => {
    if (request?.type !== 'form' || !field) return;
    const value = nextValues[field.id];
    if (field.required && (value === '' || value === undefined)) return;
    if (presenter.fieldIndex === request.fields.length - 1) void presenter.submit(nextValues);
    else presenter.setFieldIndex(presenter.fieldIndex + 1);
  };

  useInput((input, key) => {
    if (!interaction || !request) return;
    if (key.escape) {
      void presenter.cancel('escape');
      return;
    }
    const delta = key.leftArrow || key.upArrow ? -1 : key.rightArrow || key.downArrow ? 1 : 0;
    if (request.type === 'confirm') {
      if (delta || input === ' ') presenter.setValues({ confirmed: !presenter.values.confirmed });
      if (key.return) void presenter.submit();
      return;
    }
    if (request.type === 'select') {
      if (delta) {
        presenter.setValues({ value: cycle(String(presenter.values.value ?? ''), request.options, delta) });
      }
      if (key.return) void presenter.submit();
      return;
    }
    if (!field) return;
    if (field.type === 'boolean') {
      if (delta || input === ' ') presenter.setValues({ ...presenter.values, [field.id]: !presenter.values[field.id] });
      if (key.return) advance();
    } else if (field.type === 'select') {
      if (delta) {
        presenter.setValues({
          ...presenter.values,
          [field.id]: cycle(String(presenter.values[field.id] ?? ''), field.options, delta)
        });
      }
      if (key.return) advance();
    }
  });

  const summary = useMemo(() => {
    if (request?.type !== 'form') return [];
    return request.fields.slice(0, presenter.fieldIndex).map((item) => ({
      label: item.label,
      value: summarizeInteractionValue(item, presenter.values[item.id])
    }));
  }, [presenter.fieldIndex, presenter.values, request]);

  if (!interaction || !request) return null;
  const textField = field && (field.type === 'string' || field.type === 'secret' || field.type === 'number');
  const selected =
    request.type === 'select' ? request.options.find((o) => o.value === presenter.values.value) : undefined;

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <Text color={TUI_THEME.dim}>REQUESTED BY {interactionSourceLabel(interaction.source)}</Text>
      <Text
        bold
        color={TUI_THEME.glow}
      >{`${TUI_GLYPHS.caret} ${request.title}`}</Text>
      {request.description && <Text>{request.description}</Text>}
      {summary.map((item) => (
        <Text
          color={TUI_THEME.dim}
          key={item.label}
        >{`${item.label}: ${item.value}`}</Text>
      ))}
      {request.type === 'confirm' && <Text>{presenter.values.confirmed ? '[ yes ]' : '[ no ]'}</Text>}
      {request.type === 'select' && <Text>{`< ${selected?.label ?? ''} >`}</Text>}
      {request.type === 'form' && field && (
        <Box flexDirection="column">
          <Text bold>
            {field.label}
            {field.required ? ' *' : ''}
          </Text>
          {field.description && <Text color={TUI_THEME.dim}>{field.description}</Text>}
          {textField ? (
            <TextInput
              mask={field.type === 'secret' ? '*' : undefined}
              onChange={(value) => presenter.setValues({ ...presenter.values, [field.id]: value })}
              onSubmit={() => {
                const nextValues = {
                  ...presenter.values,
                  [field.id]: formValue(field, presenter.values[field.id])
                };
                presenter.setValues(nextValues);
                advance(nextValues);
              }}
              value={String(presenter.values[field.id] ?? '')}
            />
          ) : field.type === 'boolean' ? (
            <Text>{presenter.values[field.id] ? '[ yes ]' : '[ no ]'}</Text>
          ) : (
            <Text>{`< ${field.options.find((o) => o.value === presenter.values[field.id])?.label ?? ''} >`}</Text>
          )}
        </Box>
      )}
      {presenter.error && <Text color={TUI_THEME.danger}>{presenter.error}</Text>}
      <Text color={TUI_THEME.dim}>arrows/space choose · enter continue · esc cancel</Text>
    </Box>
  );
}
