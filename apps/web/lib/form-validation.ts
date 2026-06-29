import { httpUrlSchema } from '@monad/protocol';
import { z } from 'zod';

const trimmedString = z.string().trim();

function addHttpUrlIssue(ctx: z.RefinementCtx, path: string[], required: boolean): void {
  ctx.addIssue({
    code: 'custom',
    message: required ? 'url required' : 'url must be http(s)',
    path
  });
}

function parseHttpFormUrl(value: string, ctx: z.RefinementCtx, path: string[], required: boolean): string {
  if (!value) {
    if (required) addHttpUrlIssue(ctx, path, true);
    return '';
  }
  const parsed = httpUrlSchema.safeParse(value);
  if (!parsed.success) {
    addHttpUrlIssue(ctx, path, false);
    return value;
  }
  return parsed.data;
}

export function providerFormSchema(needsUrl: boolean) {
  return z
    .object({
      type: trimmedString.min(1),
      baseUrl: trimmedString
    })
    .transform((value, ctx) => ({
      ...value,
      baseUrl: parseHttpFormUrl(value.baseUrl, ctx, ['baseUrl'], needsUrl)
    }));
}

export const mcpServerFormSchema = z
  .object({
    name: trimmedString,
    transport: z.enum(['stdio', 'http']),
    command: trimmedString,
    args: z.string(),
    env: z.string(),
    cwd: trimmedString,
    url: trimmedString
  })
  .superRefine((value, ctx) => {
    if (!value.name) {
      ctx.addIssue({ code: 'custom', message: 'name required', path: ['name'] });
    }
    if (value.transport === 'stdio' && !value.command) {
      ctx.addIssue({ code: 'custom', message: 'command required', path: ['command'] });
    }
  })
  .transform((value, ctx) => ({
    ...value,
    url: value.transport === 'http' ? parseHttpFormUrl(value.url, ctx, ['url'], true) : value.url
  }));

export const daemonConnectionFormSchema = z
  .object({
    url: trimmedString,
    token: trimmedString
  })
  .transform((value, ctx) => ({
    ...value,
    url: parseHttpFormUrl(value.url, ctx, ['url'], false)
  }));
