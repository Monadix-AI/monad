// Pure validation for structured presenter interactions (confirm/select/form): safe-pattern gating,
// presenter-capability matching, and submission coercion. No lifecycle, no state — the service calls
// these at its request/claim/submit boundaries and owns the active-record transitions itself.

import type { InteractionPresenterCapabilities, InteractionRequest } from '@monad/protocol';
import type { InteractionRouting } from './types';

import safeRegex from 'safe-regex2';

import { HostInteractionError } from './errors';

const MAX_PATTERN_INPUT_LENGTH = 4_096;

function isNarrowlySafePattern(pattern: string): boolean {
  if (!safeRegex(pattern)) return false;
  let escaped = false;
  let inCharacterClass = false;
  let variableQuantifiers = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '(' || character === ')' || character === '|') return false;
    if (character === '*' || character === '+' || character === '?') variableQuantifiers += 1;
    if (character === '{') {
      const end = pattern.indexOf('}', index + 1);
      if (end === -1) return false;
      const range = pattern.slice(index + 1, end);
      if (!/^\d+(?:,\d*)?$/.test(range)) return false;
      if (range.includes(',')) variableQuantifiers += 1;
      index = end;
    }
    if (variableQuantifiers > 1) return false;
  }
  return !escaped && !inCharacterClass;
}

export function validateRequestPatterns(request: InteractionRequest): void {
  if (request.type !== 'form') return;
  for (const field of request.fields) {
    if (field.type === 'string' && field.pattern && !isNarrowlySafePattern(field.pattern)) {
      throw new HostInteractionError(
        'unsafe_pattern',
        `Interaction field "${field.id}" uses an unsafe validation pattern`
      );
    }
  }
}

export function supportsRequest(
  request: InteractionRequest,
  routing: InteractionRouting,
  capabilities: InteractionPresenterCapabilities
): void {
  if (routing.mode === 'background' && !capabilities.supportsBackgroundQueue) {
    throw new HostInteractionError('incompatible_presenter', 'Presenter cannot claim background interactions');
  }
  if (!capabilities.interactionTypes.includes(request.type)) {
    throw new HostInteractionError('incompatible_presenter', `Presenter does not support ${request.type} interactions`);
  }
  if (request.type !== 'form') return;

  for (const field of request.fields) {
    if (!capabilities.fieldTypes.includes(field.type)) {
      throw new HostInteractionError('incompatible_presenter', `Presenter does not support ${field.type} fields`);
    }
    if (field.type === 'secret' && !capabilities.supportsSecretInput) {
      throw new HostInteractionError('incompatible_presenter', 'Presenter cannot safely collect secrets');
    }
  }
}

function invalidSubmission(message: string): never {
  throw new HostInteractionError('invalid_submission', message);
}

export function validateSubmission(
  request: InteractionRequest,
  values: Record<string, unknown>
): Record<string, unknown> {
  if (request.type === 'confirm') {
    if (values.confirmed !== true) invalidSubmission('Confirmation must be explicitly accepted');
    if (Object.keys(values).some((key) => key !== 'confirmed')) {
      invalidSubmission('Confirmation contains undeclared values');
    }
    return { confirmed: true };
  }

  if (request.type === 'select') {
    if (typeof values.value !== 'string' || !request.options.some((option) => option.value === values.value)) {
      invalidSubmission('Selection must be one of the declared options');
    }
    if (Object.keys(values).some((key) => key !== 'value')) invalidSubmission('Selection contains undeclared values');
    return { value: values.value };
  }

  const fields = new Map(request.fields.map((field) => [field.id, field]));
  const validated: Record<string, unknown> = {};
  for (const field of request.fields) {
    const present = Object.hasOwn(values, field.id);
    const value = values[field.id];
    const missing = !present || value === undefined || value === null || value === '';
    if (field.required && missing) invalidSubmission(`Interaction field "${field.id}" is required`);
    if (!present || value === undefined || value === null) continue;

    switch (field.type) {
      case 'string':
      case 'secret':
        if (typeof value !== 'string') invalidSubmission(`Interaction field "${field.id}" must be a string`);
        if (field.type === 'string' && field.pattern) {
          if (value.length > MAX_PATTERN_INPUT_LENGTH) {
            invalidSubmission(`Interaction field "${field.id}" is too long for pattern validation`);
          }
          let pattern: RegExp;
          try {
            pattern = new RegExp(field.pattern);
          } catch {
            invalidSubmission(`Interaction field "${field.id}" has an invalid pattern`);
          }
          if (!pattern.test(value)) invalidSubmission(`Interaction field "${field.id}" has an invalid format`);
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          invalidSubmission(`Interaction field "${field.id}" must be a finite number`);
        }
        if (field.min !== undefined && value < field.min) {
          invalidSubmission(`Interaction field "${field.id}" must be at least ${field.min}`);
        }
        if (field.max !== undefined && value > field.max) {
          invalidSubmission(`Interaction field "${field.id}" must be at most ${field.max}`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') invalidSubmission(`Interaction field "${field.id}" must be a boolean`);
        break;
      case 'select':
        if (typeof value !== 'string' || !field.options.some((option) => option.value === value)) {
          invalidSubmission(`Interaction field "${field.id}" must be one of the declared options`);
        }
        break;
    }
    validated[field.id] = value;
  }

  for (const key of Object.keys(values)) {
    if (!fields.has(key)) invalidSubmission(`Interaction field "${key}" is not declared`);
  }
  return validated;
}
