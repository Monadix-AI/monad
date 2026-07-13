import type { InteractionField, InteractionRequest, InteractionSource, PendingInteraction } from '@monad/protocol';

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function projectField(field: InteractionField): InteractionField {
  const common = {
    id: field.id,
    label: field.label,
    description: field.description,
    required: field.required
  };

  switch (field.type) {
    case 'string':
      return defined({
        ...common,
        type: 'string' as const,
        defaultValue: field.defaultValue,
        pattern: field.pattern
      });
    case 'secret':
      return defined({ ...common, type: 'secret' as const });
    case 'number':
      return defined({
        ...common,
        type: 'number' as const,
        defaultValue: field.defaultValue,
        min: field.min,
        max: field.max
      });
    case 'boolean':
      return defined({ ...common, type: 'boolean' as const, defaultValue: field.defaultValue });
    case 'select':
      return defined({
        ...common,
        type: 'select' as const,
        defaultValue: field.defaultValue,
        options: field.options.map((option) => ({ value: option.value, label: option.label }))
      });
  }
}

/** Projects only schema fields that presenters are allowed to receive. */
export function redactInteractionRequest(request: InteractionRequest): InteractionRequest {
  const common = {
    title: request.title,
    description: request.description,
    timeoutMs: request.timeoutMs
  };

  switch (request.type) {
    case 'confirm':
      return defined({ ...common, type: 'confirm' as const, confirmLabel: request.confirmLabel });
    case 'select':
      return defined({
        ...common,
        type: 'select' as const,
        options: request.options.map((option) => ({ value: option.value, label: option.label }))
      });
    case 'form':
      return defined({
        ...common,
        type: 'form' as const,
        fields: request.fields.map(projectField),
        submitLabel: request.submitLabel
      });
  }
}

function projectSource(source: InteractionSource): InteractionSource {
  if (source.kind === 'builtin') {
    return defined({ kind: source.kind, id: source.id, label: source.label });
  }
  return { kind: source.kind, packId: source.packId, atomId: source.atomId };
}

export function projectPendingInteraction(input: PendingInteraction): PendingInteraction {
  return {
    id: input.id,
    source: projectSource(input.source),
    request: redactInteractionRequest(input.request),
    state: input.state,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt
  };
}
