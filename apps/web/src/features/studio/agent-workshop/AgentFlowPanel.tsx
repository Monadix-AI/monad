import type { A2aAgentStatus, SandboxMode } from '@monad/protocol';

import {
  BrainIcon,
  Cancel01Icon,
  CheckIcon,
  MessageMultiple01Icon,
  PencilEdit01Icon,
  ShieldHalfIcon,
  UserGroupIcon,
  Wrench01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea
} from '@monad/ui';
import { useMemo, useState } from 'react';

import { type AgentFlowNodeId, type AgentFlowValidation, appendPromptGuidance } from './agent-flow-model';

export interface AgentFlowCapability {
  detail: string;
  name: string;
  sourceKind: 'atom' | 'mcp';
}

const INHERIT = '__inherit__';
const SANDBOX_MODES: SandboxMode[] = ['workspace', 'home', 'ephemeral', 'unrestricted'];
const MODEL_ROLES = [
  { key: 'memory', label: 'Memory' },
  { key: 'vision', label: 'Vision' },
  { key: 'image', label: 'Image generation' },
  { key: 'speech', label: 'Speech' },
  { key: 'embedding', label: 'Embedding' }
] as const;
const GUIDANCE = ['Be concise.', 'Ask before risky actions.', 'Explain important decisions.'];

interface AgentFlowPanelProps {
  a2aEnabled: boolean;
  a2aStatus?: A2aAgentStatus;
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  capabilityCatalog: AgentFlowCapability[];
  description: string;
  errors: AgentFlowValidation['errors'];
  isPublic: boolean;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  model: string;
  name: string;
  onClose: () => void;
  profiles: { alias: string }[];
  prompt: string;
  roles: Record<string, string>;
  sandboxMode: SandboxMode | '';
  selected: AgentFlowNodeId;
  setA2aEnabled: (value: boolean) => void;
  setAtomsAllow: (value: string[] | ((prev: string[]) => string[])) => void;
  setAtomsMode: (value: 'inherit' | 'allowlist') => void;
  setDescription: (value: string) => void;
  setIsPublic: (value: boolean) => void;
  setMaxBudgetUsd: (value: string) => void;
  setMaxThinkingTokens: (value: string) => void;
  setMaxTurns: (value: string) => void;
  setModel: (value: string) => void;
  setName: (value: string) => void;
  setPrompt: (value: string) => void;
  setRoles: (value: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void;
  setSandboxMode: (value: SandboxMode | '') => void;
  setSubagentCallable: (value: boolean) => void;
  subagentCallable: boolean;
}

const PANEL_META = {
  request: { icon: UserGroupIcon, title: 'User request', hint: 'See what enters this agent.' },
  identity: {
    icon: PencilEdit01Icon,
    title: 'Agent identity & instructions',
    hint: 'Who is this agent and how should it act?'
  },
  model: { icon: BrainIcon, title: 'Model', hint: 'Choose how this agent thinks and responds.' },
  tools: { icon: Wrench01Icon, title: 'Tools & knowledge', hint: 'Control what this agent can access.' },
  safety: { icon: ShieldHalfIcon, title: 'Safety check', hint: 'Set boundaries for cost and execution.' },
  response: { icon: MessageMultiple01Icon, title: 'Response', hint: 'Review behavior and who can use this agent.' }
};

function FieldError({ children }: { children?: string }) {
  return children ? <p className="text-destructive text-xs">{children}</p> : null;
}

function ToggleRow({
  checked,
  label,
  hint,
  onCheckedChange
}: {
  checked: boolean;
  label: string;
  hint: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 last:border-b-0">
      <div>
        <div className="font-medium text-sm">{label}</div>
        <div className="mt-0.5 text-muted-foreground text-xs">{hint}</div>
      </div>
      <Switch
        aria-label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export function AgentFlowPanel(props: AgentFlowPanelProps) {
  const meta = PANEL_META[props.selected];

  return (
    <aside
      aria-label={`${meta.title} settings`}
      className="absolute top-[190px] right-5 bottom-20 z-20 flex w-[min(480px,calc(100%-2.5rem))] flex-col overflow-hidden rounded-2xl border bg-background shadow-xl max-md:bottom-0 max-md:rounded-b-none max-lg:inset-x-4 max-lg:top-auto max-lg:h-[min(70%,38rem)] max-lg:w-auto"
    >
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <HugeiconsIcon
            className="size-5"
            icon={meta.icon}
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-base">{meta.title}</h2>
          <p className="mt-0.5 text-muted-foreground text-xs">{meta.hint}</p>
        </div>
        <Button
          aria-label="Close settings"
          className="size-8"
          onClick={props.onClose}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {props.selected === 'request' ? <RequestPanel /> : null}
        {props.selected === 'identity' ? <IdentityPanel {...props} /> : null}
        {props.selected === 'model' ? <ModelPanel {...props} /> : null}
        {props.selected === 'tools' ? <ToolsPanel {...props} /> : null}
        {props.selected === 'safety' ? <SafetyPanel {...props} /> : null}
        {props.selected === 'response' ? <ResponsePanel {...props} /> : null}
      </div>
    </aside>
  );
}

function RequestPanel() {
  const [sample, setSample] = useState('Add error monitoring to the API');
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="agent-sample-request">Sample request</Label>
        <Textarea
          id="agent-sample-request"
          onChange={(event) => setSample(event.target.value)}
          value={sample}
        />
      </div>
      <div className="rounded-xl border bg-muted/25 p-4 text-sm">
        <div className="font-medium">What the flow will use</div>
        <p className="mt-1 text-muted-foreground">
          This example helps explain each setting. It does not call a model or create a session.
        </p>
      </div>
    </div>
  );
}

function IdentityPanel(props: AgentFlowPanelProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="flow-agent-name">Name</Label>
        <Input
          id="flow-agent-name"
          onChange={(event) => props.setName(event.target.value)}
          value={props.name}
        />
        <FieldError>{props.errors.name}</FieldError>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="flow-agent-description">When should this agent be used?</Label>
        <Input
          id="flow-agent-description"
          onChange={(event) => props.setDescription(event.target.value)}
          placeholder="For example: coding tasks that need careful changes"
          value={props.description}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="flow-agent-prompt">Instructions</Label>
        <p className="text-muted-foreground text-xs">How should the agent behave and respond?</p>
        <Textarea
          className="min-h-48 resize-y leading-relaxed"
          id="flow-agent-prompt"
          onChange={(event) => props.setPrompt(event.target.value)}
          placeholder="Describe the agent's role, priorities, and boundaries."
          value={props.prompt}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {GUIDANCE.map((guidance) => (
          <Button
            key={guidance}
            onClick={() => props.setPrompt(appendPromptGuidance(props.prompt, guidance))}
            size="sm"
            type="button"
            variant="outline"
          >
            {guidance.replace(/\.$/, '')}
          </Button>
        ))}
      </div>
      <details className="group border-t pt-4">
        <summary className="cursor-pointer font-medium text-primary text-sm">Advanced</summary>
        <p className="mt-2 text-muted-foreground text-xs">
          These instructions are stored as the agent's raw system prompt.
        </p>
      </details>
    </div>
  );
}

function ModelPanel(props: AgentFlowPanelProps) {
  const usesDefault = !props.model.trim();
  return (
    <div className="space-y-4">
      <button
        className="flex w-full items-start gap-3 rounded-xl border p-4 text-left"
        onClick={() => props.setModel('')}
        type="button"
      >
        <span className="mt-0.5 grid size-5 place-items-center rounded-full border">
          {usesDefault ? <span className="size-2.5 rounded-full bg-primary" /> : null}
        </span>
        <span>
          <span className="block font-medium text-sm">Use workspace default</span>
          <span className="mt-0.5 block text-muted-foreground text-xs">
            Follow the model selected for the workspace.
          </span>
        </span>
      </button>
      <div className="space-y-1.5">
        <Label htmlFor="flow-agent-model">Choose a specific model</Label>
        <Input
          id="flow-agent-model"
          onChange={(event) => props.setModel(event.target.value)}
          placeholder="provider/model"
          value={props.model}
        />
      </div>
      <details className="group border-t pt-4">
        <summary className="cursor-pointer font-medium text-primary text-sm">Advanced</summary>
        <div className="mt-4 space-y-4">
          <p className="text-muted-foreground text-xs">
            Override specialized model roles only when this agent needs different behavior.
          </p>
          {MODEL_ROLES.map(({ key, label }) => (
            <div
              className="space-y-1.5"
              key={key}
            >
              <Label>{label}</Label>
              <Select
                onValueChange={(value) =>
                  props.setRoles((current) => {
                    const next = { ...current };
                    if (value === INHERIT) delete next[key];
                    else next[key] = value;
                    return next;
                  })
                }
                value={props.roles[key] ?? INHERIT}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>Use workspace default</SelectItem>
                  {props.profiles.map((profile) => (
                    <SelectItem
                      key={profile.alias}
                      value={profile.alias}
                    >
                      {profile.alias}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function ToolsPanel(props: AgentFlowPanelProps) {
  const catalog = useMemo(() => {
    const known = new Map(props.capabilityCatalog.map((item) => [item.name, item]));
    for (const name of props.atomsAllow) {
      if (!known.has(name))
        known.set(name, { name, detail: 'No longer available in the workspace', sourceKind: 'atom' });
    }
    return [...known.values()];
  }, [props.atomsAllow, props.capabilityCatalog]);

  const toggleCapability = (name: string) => {
    props.setAtomsAllow((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
    );
  };

  return (
    <div className="space-y-4">
      <ToggleRow
        checked={props.atomsMode === 'inherit'}
        hint="Automatically use capabilities enabled for the workspace."
        label="Use workspace capabilities"
        onCheckedChange={(checked) => props.setAtomsMode(checked ? 'inherit' : 'allowlist')}
      />
      {props.atomsMode === 'allowlist' ? (
        <div className="space-y-2">
          <div className="font-medium text-sm">Choose capabilities for this agent</div>
          {catalog.length === 0 ? (
            <p className="text-muted-foreground text-xs">No enabled Atom Packs or MCP servers are available.</p>
          ) : null}
          {catalog.map((item) => {
            const selected = props.atomsAllow.includes(item.name);
            return (
              <button
                aria-pressed={selected}
                className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left hover:bg-muted/30"
                key={item.name}
                onClick={() => toggleCapability(item.name)}
                type="button"
              >
                <span className="grid size-5 place-items-center rounded border">
                  {selected ? (
                    <HugeiconsIcon
                      className="size-3.5"
                      icon={CheckIcon}
                    />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm">{item.name}</span>
                  <span className="block truncate text-muted-foreground text-xs">{item.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <details className="border-t pt-4">
        <summary className="cursor-pointer font-medium text-primary text-sm">Advanced</summary>
        <p className="mt-2 text-muted-foreground text-xs">
          Selected identifiers are sent unchanged to the current agent update API.
        </p>
      </details>
    </div>
  );
}

function SafetyPanel(props: AgentFlowPanelProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Sandbox</Label>
        <Select
          onValueChange={(value) => props.setSandboxMode(value === INHERIT ? '' : (value as SandboxMode))}
          value={props.sandboxMode || INHERIT}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>Use workspace default</SelectItem>
            {SANDBOX_MODES.map((mode) => (
              <SelectItem
                key={mode}
                value={mode}
              >
                {mode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <details
        className="border-t pt-4"
        open
      >
        <summary className="cursor-pointer font-medium text-primary text-sm">Advanced</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="flow-max-turns">Maximum turns</Label>
            <Input
              id="flow-max-turns"
              inputMode="numeric"
              onChange={(event) => props.setMaxTurns(event.target.value)}
              placeholder="Use workspace default"
              value={props.maxTurns}
            />
            <FieldError>{props.errors.maxTurns}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="flow-max-thinking">Maximum thinking tokens</Label>
            <Input
              id="flow-max-thinking"
              inputMode="numeric"
              onChange={(event) => props.setMaxThinkingTokens(event.target.value)}
              placeholder="Default"
              value={props.maxThinkingTokens}
            />
            <FieldError>{props.errors.maxThinkingTokens}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="flow-max-budget">Maximum budget</Label>
            <Input
              id="flow-max-budget"
              inputMode="decimal"
              onChange={(event) => props.setMaxBudgetUsd(event.target.value)}
              placeholder="USD"
              value={props.maxBudgetUsd}
            />
            <FieldError>{props.errors.maxBudgetUsd}</FieldError>
          </div>
        </div>
      </details>
    </div>
  );
}

function ResponsePanel(props: AgentFlowPanelProps) {
  const preview = props.prompt.trim()
    ? 'The agent will follow the instructions you configured and use its available tools within the selected safety limits.'
    : 'Add instructions to shape the response. Until then, the agent uses workspace defaults.';
  return (
    <div className="space-y-5">
      <div className="rounded-xl border bg-muted/25 p-4">
        <div className="font-medium text-sm">Preview of configured behavior</div>
        <p className="mt-2 text-muted-foreground text-sm leading-relaxed">{preview}</p>
      </div>
      <div>
        <h3 className="font-medium text-sm">Who can use this agent?</h3>
        <div className="mt-2">
          <ToggleRow
            checked={props.subagentCallable}
            hint="Allow delegation from other built-in agents."
            label="Other Monad agents"
            onCheckedChange={props.setSubagentCallable}
          />
          <ToggleRow
            checked={props.isPublic}
            hint="Expose this agent through the local OpenAI-compatible API."
            label="Public API"
            onCheckedChange={props.setIsPublic}
          />
          <ToggleRow
            checked={props.a2aEnabled}
            hint={props.a2aStatus ? 'A2A status is available.' : 'Enable Agent-to-Agent discovery for this agent.'}
            label="A2A"
            onCheckedChange={props.setA2aEnabled}
          />
        </div>
      </div>
      <details className="border-t pt-4">
        <summary className="cursor-pointer font-medium text-primary text-sm">Advanced</summary>
        <p className="mt-2 text-muted-foreground text-xs">
          Availability changes how other clients can call this agent; it does not alter the response pipeline.
        </p>
      </details>
    </div>
  );
}
