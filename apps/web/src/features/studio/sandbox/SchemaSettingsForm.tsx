import type { ActivateSandboxBackendRequest, SandboxBackendView } from '@monad/protocol';

import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@monad/ui';
import { useEffect, useState } from 'react';

type SecretActions = NonNullable<NonNullable<ActivateSandboxBackendRequest['settings']>['secrets']>;

export function initialSchemaValues(backend: SandboxBackendView): Record<string, unknown> {
  const values = { ...backend.settings };
  for (const field of backend.descriptor.settings?.fields ?? []) {
    if (values[field.id] !== undefined) continue;
    if (field.type === 'secret') values[field.id] = { configured: false };
    else if (field.defaultValue !== undefined) values[field.id] = field.defaultValue;
  }
  return values;
}

function replacementValue(action: SecretActions[string] | undefined): string {
  return action?.action === 'replace' ? action.value : '';
}

export function buildActivationSettings(
  values: Record<string, unknown>,
  secrets: SecretActions
): NonNullable<ActivateSandboxBackendRequest['settings']> {
  const normalValues = Object.fromEntries(
    Object.entries(values).filter(
      ([id, value]) =>
        !(id in secrets) &&
        !(value !== null && typeof value === 'object' && 'configured' in value && typeof value.configured === 'boolean')
    )
  );
  return {
    ...(Object.keys(normalValues).length ? { values: normalValues } : {}),
    ...(Object.keys(secrets).length ? { secrets } : {})
  };
}

export function SchemaSettingsForm({
  backend,
  onChange
}: {
  backend: SandboxBackendView;
  onChange: (settings: NonNullable<ActivateSandboxBackendRequest['settings']>) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initialSchemaValues(backend));
  const [secrets, setSecrets] = useState<SecretActions>({});

  useEffect(() => {
    const next = initialSchemaValues(backend);
    setValues(next);
    setSecrets({});
    onChange(buildActivationSettings(next, {}));
  }, [backend, onChange]);

  const updateValue = (id: string, value: unknown) => {
    const next = { ...values, [id]: value };
    setValues(next);
    onChange(buildActivationSettings(next, secrets));
  };
  const updateSecret = (id: string, action: SecretActions[string] | undefined) => {
    const next = { ...secrets };
    if (action) next[id] = action;
    else delete next[id];
    setSecrets(next);
    onChange(buildActivationSettings(values, next));
  };

  return (
    <div className="divide-y rounded-lg border px-3">
      {(backend.descriptor.settings?.fields ?? []).map((field) => (
        <div
          className="flex items-center justify-between gap-4 py-3"
          key={field.id}
        >
          <div className="min-w-0 flex-1">
            <Label htmlFor={`sandbox-field-${field.id}`}>{field.label}</Label>
            {field.description && <p className="text-muted-foreground text-xs">{field.description}</p>}
          </div>
          {field.type === 'boolean' ? (
            <Switch
              checked={Boolean(values[field.id])}
              onCheckedChange={(value) => updateValue(field.id, value)}
            />
          ) : field.type === 'select' ? (
            <Select
              onValueChange={(value) => updateValue(field.id, value)}
              value={String(values[field.id] ?? '')}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {field.options.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : field.type === 'secret' ? (
            <div className="flex items-center gap-2">
              <Input
                className="w-48"
                id={`sandbox-field-${field.id}`}
                onChange={(event) =>
                  updateSecret(
                    field.id,
                    event.target.value ? { action: 'replace', value: event.target.value } : undefined
                  )
                }
                placeholder={
                  (values[field.id] as { configured?: boolean })?.configured
                    ? 'Configured — enter to replace'
                    : 'Required'
                }
                type="password"
                value={replacementValue(secrets[field.id])}
              />
              {(values[field.id] as { configured?: boolean })?.configured && (
                <Button
                  onClick={() => updateSecret(field.id, { action: 'remove' })}
                  size="sm"
                  variant="ghost"
                >
                  Remove
                </Button>
              )}
            </div>
          ) : (
            <Input
              className="w-48"
              id={`sandbox-field-${field.id}`}
              max={field.type === 'number' ? field.max : undefined}
              min={field.type === 'number' ? field.min : undefined}
              onChange={(event) =>
                updateValue(field.id, field.type === 'number' ? event.target.valueAsNumber : event.target.value)
              }
              type={field.type === 'number' ? 'number' : 'text'}
              value={String(values[field.id] ?? '')}
            />
          )}
        </div>
      ))}
    </div>
  );
}
