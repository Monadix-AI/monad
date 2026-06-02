type PromptTemplate<Context> = string | ((context: Context) => string);

export interface ExperiencePromptParticipant<Role extends string> {
  id: string;
  label: string;
  role: Role;
}

export interface ExperiencePromptInjection<Stage extends string, Role extends string, Context> {
  stagePrompts?: Partial<Record<Stage, PromptTemplate<Context>>>;
  advancedPrompts?: Partial<Record<Role, PromptTemplate<Context>>>;
}

function renderPrompt<Context>(template: PromptTemplate<Context> | undefined, context: Context): string | null {
  const value = typeof template === 'function' ? template(context) : template;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function injectExperiencePrompts<Stage extends string, Role extends string, Context>(input: {
  basePrompt: string;
  stage: Stage;
  context: Context;
  participants: readonly ExperiencePromptParticipant<Role>[];
  injection?: ExperiencePromptInjection<Stage, Role, Context>;
}): string {
  if (!input.injection) return input.basePrompt;
  const sections = [input.basePrompt.trim()];
  const stagePrompt = renderPrompt(input.injection.stagePrompts?.[input.stage], input.context);
  if (stagePrompt) sections.push(`Stage prompt:\n${stagePrompt}`);

  for (const [role, template] of Object.entries(input.injection.advancedPrompts ?? {}) as Array<
    [Role, PromptTemplate<Context>]
  >) {
    const participants = input.participants.filter((participant) => participant.role === role);
    if (!participants.length) continue;
    const advancedPrompt = renderPrompt(template, input.context);
    if (!advancedPrompt) continue;
    const identities = participants.map((participant) => `${participant.label} (${participant.id})`).join(', ');
    sections.push(`Advanced prompt for ${role} [${identities}]:\n${advancedPrompt}`);
  }

  return sections.join('\n\n');
}
