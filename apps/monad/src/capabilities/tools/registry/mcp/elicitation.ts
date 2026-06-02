import type { ClarifyForm, ClarifyFormOption } from '@monad/protocol';
import type { ToolContext } from '../../types.ts';

import { newId } from '@monad/protocol';

import { recordMcpUrlElicitation } from './runtime-telemetry.ts';

type Ask = NonNullable<ToolContext['ask']>;
type ElicitationValue = boolean | number | string | string[];

interface ElicitationField {
  name: string;
  title?: string;
  description?: string;
  required: boolean;
  type: 'boolean' | 'integer' | 'multi-select' | 'number' | 'single-select' | 'string';
  options?: ClarifyFormOption[];
  defaultValue?: ElicitationValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: 'date' | 'date-time' | 'email' | 'uri';
}

export interface ElicitationOptions {
  serverName?: string;
  resolveClarification?: ToolContext['resolveClarification'];
  registerUrlCompletion?: (elicitationId: string, complete: () => Promise<void>) => () => void;
}

export async function fulfillElicitationRequests(
  inputRequests: Record<string, unknown> | undefined,
  ask: Ask | undefined,
  options: ElicitationOptions = {}
): Promise<Record<string, unknown> | undefined> {
  if (!inputRequests || !Object.keys(inputRequests).length) return undefined;
  const responses: Array<[string, unknown]> = [];
  for (const [key, request] of Object.entries(inputRequests)) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) continue;
    const value = request as { method?: unknown; params?: unknown };
    if (value.method !== 'elicitation/create' || !value.params || typeof value.params !== 'object') continue;
    responses.push([key, await fulfillElicitation(value.params as Record<string, unknown>, ask, options)]);
  }
  return responses.length ? Object.fromEntries(responses) : undefined;
}

export async function fulfillElicitation(
  params: Record<string, unknown>,
  ask: Ask | undefined,
  options: ElicitationOptions = {}
): Promise<{ action: 'accept' | 'cancel' | 'decline'; content?: Record<string, ElicitationValue> }> {
  if (!ask) return { action: 'decline' };
  if (params.mode === 'url') return fulfillUrlElicitation(params, ask, options);
  const fields = requestedFields(params.requestedSchema);
  if (fields.some(isSensitiveField)) return { action: 'decline' };
  const baseQuestion = typeof params.message === 'string' ? params.message : 'Additional input is required.';
  let validation: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await ask({
      question: validation ? `${baseQuestion}\n${validation}` : baseQuestion,
      form: formFor(fields),
      ...(options.serverName ? { asker: { name: options.serverName } } : {})
    });
    if (answer.status !== 'answered') {
      return { action: answer.status === 'cancelled' ? 'cancel' : 'decline' };
    }
    try {
      return { action: 'accept', content: parseFormAnswer(fields, answer.answer) };
    } catch (error) {
      validation = error instanceof Error ? error.message : String(error);
    }
  }
  return { action: 'decline' };
}

async function fulfillUrlElicitation(
  params: Record<string, unknown>,
  ask: Ask,
  options: ElicitationOptions
): Promise<{ action: 'accept' | 'cancel' | 'decline' }> {
  if (typeof params.url !== 'string' || params.url.length > 2048) return urlOutcome('decline');
  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    return urlOutcome('decline');
  }
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password) return urlOutcome('decline');
  const message = typeof params.message === 'string' && params.message.trim() ? `${params.message.trim()}\n\n` : '';
  const requestId = newId('clarify');
  const elicitationId = typeof params.elicitationId === 'string' ? params.elicitationId : undefined;
  const unregister =
    elicitationId && options.resolveClarification && options.registerUrlCompletion
      ? options.registerUrlCompletion(elicitationId, async () => {
          await options.resolveClarification?.(requestId, 'complete');
        })
      : undefined;
  const response = await ask({
    requestId,
    question: `${message}${url.toString()}`,
    ...(options.serverName ? { asker: { name: options.serverName } } : {}),
    urlElicitation: {
      url: url.toString(),
      origin: url.origin,
      ...(elicitationId ? { elicitationId } : {})
    }
  }).finally(unregister);
  if (response.status === 'cancelled') return urlOutcome('cancel');
  if (response.status !== 'answered') return urlOutcome('decline');
  if (['complete', 'completed', 'done'].includes(response.answer.trim().toLowerCase())) return urlOutcome('accept');
  return urlOutcome('decline');
}

function urlOutcome(action: 'accept' | 'cancel' | 'decline'): { action: 'accept' | 'cancel' | 'decline' } {
  recordMcpUrlElicitation(action === 'accept' ? 'accepted' : action === 'cancel' ? 'cancelled' : 'declined');
  return { action };
}

function requestedFields(schema: unknown): ElicitationField[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [{ name: 'answer', required: true, type: 'string' }];
  }
  const required = new Set(
    Array.isArray((schema as Record<string, unknown>).required)
      ? ((schema as Record<string, unknown>).required as unknown[]).filter(
          (name): name is string => typeof name === 'string'
        )
      : []
  );
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return [{ name: 'answer', required: true, type: 'string' }];
  }
  const fields = Object.entries(properties)
    .filter(([name]) => !['__proto__', 'prototype', 'constructor'].includes(name))
    .map(([name, value]): ElicitationField => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { name, required: required.has(name), type: 'string' };
      }
      const property = value as Record<string, unknown>;
      const arrayOptions = property.type === 'array' ? optionsFor(arrayItems(property.items)) : undefined;
      const scalarOptions = optionsFor(property);
      const type =
        property.type === 'array'
          ? 'multi-select'
          : scalarOptions?.length
            ? 'single-select'
            : property.type === 'boolean' || property.type === 'integer' || property.type === 'number'
              ? property.type
              : 'string';
      const options = type === 'multi-select' ? arrayOptions : scalarOptions;
      const defaultValue = validDefault(property.default, type);
      return {
        name,
        required: required.has(name),
        type,
        ...(typeof property.title === 'string' ? { title: property.title } : {}),
        ...(typeof property.description === 'string' ? { description: property.description } : {}),
        ...(options?.length ? { options } : {}),
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        ...(typeof property.minimum === 'number' && Number.isFinite(property.minimum)
          ? { minimum: property.minimum }
          : {}),
        ...(typeof property.maximum === 'number' && Number.isFinite(property.maximum)
          ? { maximum: property.maximum }
          : {}),
        ...(typeof property.minLength === 'number' && Number.isInteger(property.minLength) && property.minLength >= 0
          ? { minLength: property.minLength }
          : {}),
        ...(typeof property.maxLength === 'number' && Number.isInteger(property.maxLength) && property.maxLength >= 0
          ? { maxLength: property.maxLength }
          : {}),
        ...(typeof property.minItems === 'number' && Number.isInteger(property.minItems) && property.minItems >= 0
          ? { minItems: property.minItems }
          : {}),
        ...(typeof property.maxItems === 'number' && Number.isInteger(property.maxItems) && property.maxItems >= 0
          ? { maxItems: property.maxItems }
          : {}),
        ...(typeof property.pattern === 'string' ? { pattern: property.pattern } : {}),
        ...(property.format === 'email' ||
        property.format === 'uri' ||
        property.format === 'date' ||
        property.format === 'date-time'
          ? { format: property.format }
          : {})
      };
    });
  return fields.length ? fields : [{ name: 'answer', required: true, type: 'string' }];
}

function arrayItems(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function optionsFor(property: Record<string, unknown> | undefined): ClarifyFormOption[] | undefined {
  if (!property) return undefined;
  if (Array.isArray(property.enum)) {
    const values = property.enum.filter((item): item is string => typeof item === 'string');
    return values.map((value) => ({ value, label: value }));
  }
  const choices = Array.isArray(property.oneOf)
    ? property.oneOf
    : Array.isArray(property.anyOf)
      ? property.anyOf
      : undefined;
  if (!choices) return undefined;
  const options = choices.flatMap((choice) => {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return [];
    const item = choice as Record<string, unknown>;
    return typeof item.const === 'string'
      ? [{ value: item.const, label: typeof item.title === 'string' ? item.title : item.const }]
      : [];
  });
  return options.length ? options : undefined;
}

function validDefault(value: unknown, type: ElicitationField['type']): ElicitationValue | undefined {
  if (type === 'multi-select') {
    return Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : undefined;
  }
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (type === 'number' || type === 'integer')
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return typeof value === 'string' ? value : undefined;
}

function formFor(fields: ElicitationField[]): ClarifyForm {
  return {
    fields: fields.map((field) => ({
      name: field.name,
      label: field.title ?? field.name,
      required: field.required,
      type: field.type,
      ...(field.description ? { description: field.description } : {}),
      ...(field.options ? { options: field.options } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
      ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
      ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
      ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
      ...(field.minItems !== undefined ? { minItems: field.minItems } : {}),
      ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
      ...(field.pattern ? { pattern: field.pattern } : {}),
      ...(field.format ? { format: field.format } : {})
    }))
  };
}

function parseFormAnswer(fields: ElicitationField[], answer: string): Record<string, ElicitationValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    throw new Error('Elicitation form response must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Elicitation form response must be a JSON object');
  }
  const input = parsed as Record<string, unknown>;
  const content: Record<string, ElicitationValue> = {};
  for (const field of fields) {
    const value = input[field.name];
    if (value === undefined || value === '') {
      if (field.required) throw new Error(`Elicitation response for "${field.name}" is required`);
      continue;
    }
    content[field.name] = coerceFieldAnswer(field, value);
  }
  return content;
}

function coerceFieldAnswer(field: ElicitationField, answer: unknown): ElicitationValue {
  if (field.type === 'string') {
    if (typeof answer !== 'string') throw new Error(`Elicitation response for "${field.name}" must be text`);
    if (field.minLength !== undefined && answer.length < field.minLength) {
      throw new Error(`Elicitation response for "${field.name}" must contain at least ${field.minLength} characters`);
    }
    if (field.maxLength !== undefined && answer.length > field.maxLength) {
      throw new Error(`Elicitation response for "${field.name}" must contain at most ${field.maxLength} characters`);
    }
    if (field.pattern) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(field.pattern);
      } catch {
        throw new Error(`Elicitation schema pattern for "${field.name}" is invalid`);
      }
      if (!pattern.test(answer)) throw new Error(`Elicitation response for "${field.name}" has an invalid format`);
    }
    if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer)) {
      throw new Error(`Elicitation response for "${field.name}" must be an email address`);
    }
    if (field.format === 'uri' && !URL.canParse(answer)) {
      throw new Error(`Elicitation response for "${field.name}" must be a URI`);
    }
    if (field.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(answer)) {
      throw new Error(`Elicitation response for "${field.name}" must be a date`);
    }
    if (field.format === 'date-time' && Number.isNaN(Date.parse(answer))) {
      throw new Error(`Elicitation response for "${field.name}" must be a date-time`);
    }
    return answer;
  }
  if (field.type === 'boolean') {
    if (typeof answer === 'boolean') return answer;
    throw new Error(`Elicitation response for "${field.name}" must be true or false`);
  }
  if (field.type === 'single-select') {
    if (typeof answer === 'string' && field.options?.some((option) => option.value === answer)) return answer;
    throw new Error(`Elicitation response for "${field.name}" is not one of the allowed values`);
  }
  if (field.type === 'multi-select') {
    if (!Array.isArray(answer) || !answer.every((item): item is string => typeof item === 'string')) {
      throw new Error(`Elicitation response for "${field.name}" must be a list`);
    }
    if (answer.some((item) => !field.options?.some((option) => option.value === item))) {
      throw new Error(`Elicitation response for "${field.name}" contains an unsupported value`);
    }
    if (field.minItems !== undefined && answer.length < field.minItems) {
      throw new Error(`Elicitation response for "${field.name}" requires at least ${field.minItems} values`);
    }
    if (field.maxItems !== undefined && answer.length > field.maxItems) {
      throw new Error(`Elicitation response for "${field.name}" allows at most ${field.maxItems} values`);
    }
    return answer;
  }
  const value = typeof answer === 'number' ? answer : Number.NaN;
  if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) {
    throw new Error(
      `Elicitation response for "${field.name}" must be ${field.type === 'integer' ? 'an integer' : 'a number'}`
    );
  }
  if (field.minimum !== undefined && value < field.minimum) {
    throw new Error(`Elicitation response for "${field.name}" must be at least ${field.minimum}`);
  }
  if (field.maximum !== undefined && value > field.maximum) {
    throw new Error(`Elicitation response for "${field.name}" must be at most ${field.maximum}`);
  }
  return value;
}

function isSensitiveField(field: ElicitationField): boolean {
  const text = `${field.name} ${field.title ?? ''} ${field.description ?? ''}`.toLowerCase();
  return /(?:\bpassword\b|\bpasscode\b|\bapi[ _-]?key\b|\baccess[ _-]?token\b|\bsecret\b|\bprivate[ _-]?key\b|\bcredit[ _-]?card\b|\bcard[ _-]?number\b|\bcvv\b|\bcvc\b)/.test(
    text
  );
}
