import { z } from 'zod';

export const commandHookSettingSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  /** `deny` fails closed (a failed/timed-out hook blocks the step); `allow` (default) skips it. */
  onError: z.enum(['allow', 'deny']).optional()
});
export type CommandHookSetting = z.infer<typeof commandHookSettingSchema>;

export const hookMatcherSettingSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(commandHookSettingSchema)
});
export type HookMatcherSetting = z.infer<typeof hookMatcherSettingSchema>;

const hookEventArraySchema = z.array(hookMatcherSettingSchema).optional();

export const hooksSettingsResponseSchema = z.object({
  hooks: z.object({
    SessionStart: hookEventArraySchema,
    BeforeTurn: hookEventArraySchema,
    BeforeModel: hookEventArraySchema,
    BeforeTool: hookEventArraySchema,
    ApprovalRequest: hookEventArraySchema,
    AfterTool: hookEventArraySchema,
    AfterModel: hookEventArraySchema,
    BeforeCompact: hookEventArraySchema,
    AfterCompact: hookEventArraySchema,
    BeforeSubagent: hookEventArraySchema,
    AfterSubagent: hookEventArraySchema,
    AfterTurn: hookEventArraySchema,
    SessionEnd: hookEventArraySchema
  })
});
export type HooksSettingsResponse = z.infer<typeof hooksSettingsResponseSchema>;

export const setHooksSettingsRequestSchema = hooksSettingsResponseSchema;
export type SetHooksSettingsRequest = HooksSettingsResponse;
