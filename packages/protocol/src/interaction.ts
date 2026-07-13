import { z } from 'zod';

const titleSchema = z.string().min(1).max(120);
const descriptionSchema = z.string().max(2_000).optional();
const fieldIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);
const optionSchema = z.object({ value: z.string().max(256), label: z.string().min(1).max(200) }).strict();
const optionsSchema = z.array(optionSchema).min(1).max(100);
const commonField = {
  id: fieldIdSchema,
  label: z.string().min(1).max(200),
  description: z.string().max(1_000).optional(),
  required: z.boolean().optional()
};

export const interactionFieldSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...commonField,
      type: z.literal('string'),
      defaultValue: z.string().optional(),
      pattern: z.string().max(256).optional()
    })
    .strict(),
  z.object({ ...commonField, type: z.literal('secret') }).strict(),
  z
    .object({
      ...commonField,
      type: z.literal('number'),
      defaultValue: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional()
    })
    .strict(),
  z.object({ ...commonField, type: z.literal('boolean'), defaultValue: z.boolean().optional() }).strict(),
  z
    .object({ ...commonField, type: z.literal('select'), defaultValue: z.string().optional(), options: optionsSchema })
    .strict()
]);
export type InteractionField = z.infer<typeof interactionFieldSchema>;

const requestBase = {
  title: titleSchema,
  description: descriptionSchema,
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional()
};

export const interactionRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...requestBase, type: z.literal('confirm'), confirmLabel: z.string().max(80).optional() }).strict(),
  z.object({ ...requestBase, type: z.literal('select'), options: optionsSchema }).strict(),
  z
    .object({
      ...requestBase,
      type: z.literal('form'),
      fields: z.array(interactionFieldSchema).min(1).max(32),
      submitLabel: z.string().max(80).optional()
    })
    .strict()
]);
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;

export const interactionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('submitted'), values: z.record(z.string(), z.unknown()) }).strict(),
  z
    .object({
      status: z.literal('cancelled'),
      reason: z.enum(['close', 'escape', 'timeout', 'disconnect', 'unavailable'])
    })
    .strict()
]);
export type InteractionResult = z.infer<typeof interactionResultSchema>;

export const interactionPresenterCapabilitiesSchema = z
  .object({
    interactionTypes: z.array(z.enum(['confirm', 'select', 'form'])),
    fieldTypes: z.array(z.enum(['string', 'secret', 'number', 'boolean', 'select'])),
    supportsSecretInput: z.boolean(),
    supportsBackgroundQueue: z.boolean()
  })
  .strict();
export type InteractionPresenterCapabilities = z.infer<typeof interactionPresenterCapabilitiesSchema>;

export const interactionSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), id: z.string().min(1), label: z.string().optional() }).strict(),
  z.object({ kind: z.literal('atom-pack'), packId: z.string().min(1), atomId: z.string().min(1) }).strict()
]);
export type InteractionSource = z.infer<typeof interactionSourceSchema>;

export const pendingInteractionSchema = z
  .object({
    id: z.string().min(1),
    source: interactionSourceSchema,
    request: interactionRequestSchema,
    mode: z.enum(['foreground', 'background']),
    state: z.enum(['pending', 'claimed']),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime()
  })
  .strict();
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

export const interactionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upsert'), interaction: pendingInteractionSchema }).strict(),
  z
    .object({
      type: z.literal('removed'),
      id: z.string().min(1),
      outcome: z.enum(['submitted', 'cancelled', 'timeout'])
    })
    .strict()
]);
export type InteractionEvent = z.infer<typeof interactionEventSchema>;
