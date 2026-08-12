import type { McpServerView, McpServerWrite } from '@monad/protocol';

import { zodResolver } from '@hookform/resolvers/zod';
import { Cancel01Icon, LoaderPinwheelIcon, PlusSignIcon, SaveIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@monad/ui';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { useT } from '#/components/I18nProvider';
import { DialogBody, DialogFooter } from '#/components/ui/dialog';
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
const configuredMapToStr = (map?: Record<string, { configured: boolean }>): string =>
  Object.keys(map ?? {})
    .map((key) => `${key}=`)
    .join('\n');

export function ServerForm({
  server,
  title,
  submitLabel,
  nameLocked,
  onSubmit,
  onCancel,
  error,
  variant = 'default'
}: {
  server?: McpServerView;
  title?: string;
  submitLabel: string;
  nameLocked?: boolean;
  onSubmit: (server: McpServerWrite) => Promise<void>;
  onCancel?: () => void;
  error?: string;
  variant?: 'default' | 'dialog';
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
  const [token, setToken] = useState('');
  const [headers, setHeaders] = useState(
    configuredMapToStr(server?.transport === 'http' && server.auth.mode === 'headers' ? server.auth.headers : undefined)
  );
  const [busy, setBusy] = useState(false);
  const formValues: McpServerFormValues = { name, transport, command, args, env, cwd, url };
  const serverForm = useForm<McpServerFormValues>({
    values: formValues,
    resolver: zodResolver(mcpServerFormSchema)
  });
  const errors = serverForm.formState.errors;

  const oauthLocked = originalAuthMode === 'oauth' && authMode === 'oauth';
  const bearerTokenRequired =
    transport === 'http' &&
    authMode === 'bearer' &&
    !(server?.transport === 'http' && server.auth.mode === 'bearer' && server.auth.token.configured) &&
    !token.trim();

  const buildAuth = (): Extract<McpServerWrite, { transport: 'http' }>['auth'] => {
    if (authMode === 'bearer') {
      const nextToken = token.trim();
      return nextToken ? { mode: 'bearer', token: { action: 'replace', value: nextToken } } : { mode: 'bearer' };
    }
    if (authMode === 'headers') {
      const values = strToMap(headers);
      const previous =
        server?.transport === 'http' && server.auth.mode === 'headers'
          ? new Set(Object.keys(server.auth.headers))
          : null;
      const updates: Extract<Extract<McpServerWrite, { transport: 'http' }>['auth'], { mode: 'headers' }>['headers'] =
        {};
      for (const [name, value] of Object.entries(values)) {
        if (value) updates[name] = { action: 'replace', value };
      }
      for (const name of previous ?? []) {
        if (!(name in values)) updates[name] = { action: 'remove' };
      }
      return { mode: 'headers', headers: updates };
    }
    if (authMode === 'oauth' && server?.transport === 'http' && server.auth.mode === 'oauth') return server.auth;
    return { mode: 'none' };
  };

  const submit = serverForm.handleSubmit(async (values) => {
    setBusy(true);
    try {
      const trust = server?.trust ?? { autoApproveTools: [], hostEscape: false };
      let next: McpServerWrite;
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
  const controlClassName = variant === 'dialog' ? 'bg-card' : undefined;
  const textareaClassName =
    variant === 'dialog'
      ? 'min-h-[88px] rounded-md border bg-card px-2.5 py-2 font-code text-xs leading-normal'
      : 'min-h-16 rounded-md border bg-transparent px-2 py-1 font-code text-xs';
  const FormContainer = variant === 'dialog' ? DialogBody : 'div';

  return (
    <>
      <FormContainer className={wrapper}>
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
            className={controlClassName}
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
            <SelectTrigger className={controlClassName}>
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
                className={controlClassName}
                onChange={(event) => setCommand(event.target.value)}
                placeholder={t('web.mcp.commandPlaceholder')}
                value={command}
              />
              {errors.command ? <p className="text-destructive text-xs">{t('web.url.required')}</p> : null}
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.mcp.args')}</Label>
              <Input
                className={controlClassName}
                onChange={(event) => setArgs(event.target.value)}
                placeholder={t('web.mcp.argsPlaceholder')}
                value={args}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.mcp.workingDir')}</Label>
              <Input
                className={controlClassName}
                onChange={(event) => setCwd(event.target.value)}
                placeholder={t('web.mcp.workingDirPlaceholder')}
                value={cwd}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">{t('web.mcp.env')}</Label>
              <textarea
                className={textareaClassName}
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
                className={controlClassName}
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
                <SelectTrigger className={controlClassName}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('web.mcp.authNone')}</SelectItem>
                  <SelectItem value="bearer">{t('web.mcp.authBearer')}</SelectItem>
                  <SelectItem value="headers">{t('web.mcp.authHeaders')}</SelectItem>
                  {originalAuthMode === 'oauth' ? (
                    <SelectItem value="oauth">{t('web.mcp.authOauth')}</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
            {oauthLocked ? <p className="text-muted-foreground text-xs">{t('web.mcp.authOauthNote')}</p> : null}
            {authMode === 'bearer' ? (
              <div className="flex flex-col gap-1">
                <Label className="text-xs">{t('web.mcp.token')}</Label>
                <Input
                  className={controlClassName}
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
                  className={textareaClassName}
                  onChange={(event) => setHeaders(event.target.value)}
                  placeholder={t('web.mcp.headersPlaceholder')}
                  value={headers}
                />
              </div>
            ) : null}
          </>
        )}

        {error ? <p className="text-destructive text-xs">{error}</p> : null}
        {variant !== 'dialog' ? (
          <Button
            className="self-start"
            disabled={
              busy || bearerTokenRequired || !name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())
            }
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
        ) : null}
      </FormContainer>
      {variant === 'dialog' ? (
        <DialogFooter>
          {onCancel ? (
            <Button
              onClick={onCancel}
              size="sm"
              variant="outline"
            >
              {t('web.common.cancel')}
            </Button>
          ) : null}
          <Button
            disabled={
              busy || bearerTokenRequired || !name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())
            }
            onClick={() => void submit()}
            size="sm"
          >
            {busy ? (
              <HugeiconsIcon
                className="animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : (
              <HugeiconsIcon icon={SaveIcon} />
            )}{' '}
            {submitLabel}
          </Button>
        </DialogFooter>
      ) : null}
    </>
  );
}
