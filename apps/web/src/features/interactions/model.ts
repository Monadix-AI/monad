import type { InteractionRequest, InteractionSource } from '@monad/protocol';

export function interactionSourceLabel(source: InteractionSource): string {
  return source.kind === 'builtin' ? (source.label ?? source.id) : `${source.packId} · ${source.atomId}`;
}

export function initialInteractionValues(request: InteractionRequest): Record<string, unknown> {
  if (request.type === 'confirm') return { confirmed: false };
  if (request.type === 'select') return { value: request.options[0]?.value ?? '' };

  return Object.fromEntries(
    request.fields.map((field) => {
      switch (field.type) {
        case 'string':
          return [field.id, field.defaultValue ?? ''];
        case 'secret':
          return [field.id, ''];
        case 'number':
          return [field.id, field.defaultValue ?? ''];
        case 'boolean':
          return [field.id, field.defaultValue ?? false];
        case 'select':
          return [field.id, field.defaultValue ?? field.options[0]?.value ?? ''];
      }
      throw new Error('Unsupported interaction field');
    })
  );
}

export function validateInteractionValues(
  request: InteractionRequest,
  values: Record<string, unknown>
): Record<string, string> {
  if (request.type !== 'form') return {};
  const errors: Record<string, string> = {};

  for (const field of request.fields) {
    const value = values[field.id];
    const missing = value === undefined || value === null || value === '';
    if (field.required && missing) {
      errors[field.id] = 'Required';
      continue;
    }
    if (missing) continue;

    if (field.type === 'string' && field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(String(value))) errors[field.id] = 'Invalid format';
      } catch {
        errors[field.id] = 'Invalid format';
      }
    } else if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) errors[field.id] = 'Enter a number';
      else if (field.min !== undefined && number < field.min) errors[field.id] = `Must be at least ${field.min}`;
      else if (field.max !== undefined && number > field.max) errors[field.id] = `Must be at most ${field.max}`;
    } else if (field.type === 'select' && !field.options.some((option) => option.value === value)) {
      errors[field.id] = 'Select a valid option';
    }
  }
  return errors;
}
