import type { McpServerView } from '@monad/protocol';

import { zodResolver } from '@hookform/resolvers/zod';
import { Cancel01Icon, LoaderPinwheelIcon, PlusSignIcon, SaveIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@monad/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { useT } from '#/components/I18nProvider';
import { mcpServerFormSchema } from '#/lib/form-validation';

type AuthMode = 'none' | 'bearer' | 'headers' | 'oauth';
type McpServerFormValues = {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
};

const argsToStr = (args?: string[]): string => (args ?? []).join(' ');
const strToArgs = (value: string): string[] => value.split(/\s+/).filter(Boolean);
const mapToStr = (map?: Record<string, string>): string =>
  Object.entries(map ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
const strToMap = (value: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
};

export function ServerForm({
  server,
  title,
  submitLabel,
  nameLocked,
  onSubmit,
  onCancel
}: {
  server?: McpServerView;
  title?: string;
  submitLabel: string;
  nameLocked?: boolean;
  onSubmit: (server: McpServerView) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(server?.transport ?? 'stdio');
  const [command, setCommand] = useState(server?.transport === 'stdio' ? server.command : '');
  const [args, setArgs] = useState(argsToStr(server?.transport === 'stdio' ? server.args : undefined));
  const [env, setEnv] = useState(mapToStr(server?.transport === 'stdio' ? server.env : undefined));
  const [cwd, setCwd] = useState((server?.transport === 'stdio' ? server.cwd : '') ?? '');
  const [url, setUrl] = useState(server?.transport === 'http' ? server.url : '');
  const originalAuthMode: AuthMode = server?.transport === 'http' ? server.auth.mode : 'none';
  const [authMode, setAuthMode] = useState<AuthMode>(originalAuthMode);
  const [token, setToken] = useState(
    server?.transport === 'http' && server.auth.mode === 'bearer' ? server.auth.token : ''
  );
  const [headers, setHeaders] = useState(
    mapToStr(server?.transport === 'http' && server.auth.mode === 'headers' ? server.auth.headers : undefined)
  );
  const [busy, setBusy] = useState(false);
  const formValues: McpServerFormValues = { name, transport, command, args, env, cwd, url };
  const serverForm = useForm<McpServerFormValues>({
    values: formValues,
    resolver: zodResolver(mcpServerFormSchema)
  });
  const errors = serverForm.formState.errors;

  const oauthLocked = originalAuthMode === 'oauth' && authMode === 'oauth';

  const buildAuth = (): Extract<McpServerView, { transport: 'http' }>['auth'] => {
    if (authMode === 'bearer') return { mode: 'bearer', token: token.trim() };
    if (authMode === 'headers') return { mode: 'headers', headers: strToMap(headers) };
    if (authMode === 'oauth' && server?.transport === 'http' && server.auth.mode === 'oauth') return server.auth;
    return { mode: 'none' };
  };

  const submit = serverForm.handleSubmit(async (values) => {
    setBusy(true);
    try {
      const trust = server?.trust ?? { autoApproveTools: [] };
      let next: McpServerView;
      if (values.transport === 'stdio') {
        const envRec = strToMap(values.env);
        next = {
          name: values.name,
          transport: 'stdio',
          command: values.command,
          args: strToArgs(values.args),
          env: Object.keys(envRec).length ? envRec : undefined,
          cwd: values.cwd || undefined,
          enabled: server?.enabled ?? true,
          trust
        };
      } else {
        next = {
          name: values.name,
          transport: 'http',
          url: values.url,
          auth: buildAuth(),
          enabled: server?.enabled ?? true,
          trust
        };
      }
      await onSubmit(next);
    } finally {
      setBusy(false);
    }
  });

  const wrapper = title
    ? 'flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3'
    : 'flex flex-col gap-3';

  return (
    <div className={wrapper}>
      {title ? (
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">{title}</span>
          {onCancel ? (
            <Button
              className="size-6"
              onClick={onCancel}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon icon={Cancel01Icon} />
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.mcp.name')}</Label>
        <Input
          aria-invalid={!!errors.name || undefined}
          disabled={nameLocked}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('web.mcp.namePlaceholder')}
          value={name}
        />
        {errors.name ? <p className="text-destructive text-xs">{t('web.url.required')}</p> : null}
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.mcp.transport')}</Label>
        <Select
          onValueChange={(value) => setTransport(value as 'stdio' | 'http')}
          value={transport}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">{t('web.mcp.transportStdio')}</SelectItem>
            <SelectItem value="http">{t('web.mcp.transportHttp')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {transport === 'stdio' ? (
        <>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.command')}</Label>
            <Input
              aria-invalid={!!errors.command || undefined}
              onChange={(event) => setCommand(event.target.value)}
              placeholder={t('web.mcp.commandPlaceholder')}
              value={command}
            />
            {errors.command ? <p className="text-destructive text-xs">{t('web.url.required')}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.args')}</Label>
            <Input
              onChange={(event) => setArgs(event.target.value)}
              placeholder={t('web.mcp.argsPlaceholder')}
              value={args}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.workingDir')}</Label>
            <Input
              onChange={(event) => setCwd(event.target.value)}
              placeholder={t('web.mcp.workingDirPlaceholder')}
              value={cwd}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.env')}</Label>
            <textarea
              className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
              onChange={(event) => setEnv(event.target.value)}
              placeholder={t('web.mcp.envPlaceholder')}
              value={env}
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.url')}</Label>
            <Input
              aria-invalid={!!errors.url || undefined}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('web.mcp.urlPlaceholder')}
              value={url}
            />
            {errors.url ? <p className="text-destructive text-xs">{t('web.url.httpOnly')}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">{t('web.mcp.auth')}</Label>
            <Select
              onValueChange={(value) => setAuthMode(value as AuthMode)}
              value={authMode}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('web.mcp.authNone')}</SelectItem>
                <SelectItem value="bearer">{t('web.mcp.authBearer')}</SelectItem>
                <SelectItem value="headers">{t('web.mcp.authHeaders')}</SelectItem>
                {originalAuthMode === 'oauth' ? <SelectItem value="oauth">{t('web.mcp.authOauth')}</SelectItem> : null}
              </SelectContent>
            </Select>
          </div>
          {oauthLocked ? <p className="text-muted-foreground text-xs">{t('web.mcp.authOauthNote')}</p> : null}
          {authMode === 'bearer' ? (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.mcp.token')}</Label>
              <Input
                onChange={(event) => setToken(event.target.value)}
                placeholder={t('web.mcp.tokenPlaceholder')}
                value={token}
              />
            </div>
          ) : null}
          {authMode === 'headers' ? (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.mcp.headers')}</Label>
              <textarea
                className="min-h-16 rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
                onChange={(event) => setHeaders(event.target.value)}
                placeholder={t('web.mcp.headersPlaceholder')}
                value={headers}
              />
            </div>
          ) : null}
        </>
      )}

      <Button
        className="self-start"
        disabled={busy || !name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())}
        onClick={() => void submit()}
        size="sm"
      >
        {busy ? (
          <HugeiconsIcon
            className="animate-spin"
            icon={LoaderPinwheelIcon}
          />
        ) : title ? (
          <HugeiconsIcon icon={PlusSignIcon} />
        ) : (
          <HugeiconsIcon icon={SaveIcon} />
        )}{' '}
        {submitLabel}
      </Button>
    </div>
  );
}
