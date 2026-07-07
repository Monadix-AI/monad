# Third-party slash commands

Atom packs can contribute slash commands with `defineCommand()` from `@monad/sdk-atom`.
Commands are host-run actions: the daemon owns parsing, permission checks, conflict resolution, and
execution. The web composer, CLI, ACP clients, and `/help` all discover the same command metadata
from `/v1/commands`.

## Minimal command

```ts
import { defineCommand } from '@monad/sdk-atom';

export const pingCommand = defineCommand({
  name: 'ping',
  description: 'Ping the demo atom pack',
  async run(ctx, args) {
    const message = args.trim();
    return { message: message ? `pong: ${message}` : 'pong' };
  }
});
```

When installed from an atom pack named `multi-demo`, the command is always addressable as
`/multi-demo.ping`. The bare `/ping` form is available when it does not collide with a built-in or a
pinned command from another pack.

## Structured arguments

Use `args` to describe positional arguments for autocomplete and display. Execution still receives
the raw `args` string; command code remains responsible for its final validation.

```ts
export const pingCommand = defineCommand({
  name: 'ping',
  description: 'Ping the demo atom pack',
  args: [{ name: 'message', type: 'string', required: false, placeholder: '[message]' }],
  async run(ctx, args) {
    return { message: args.trim() ? `pong: ${args.trim()}` : 'pong' };
  }
});
```

Supported argument types:

| Type | Use |
| --- | --- |
| `string` | Free text. No value autocomplete. |
| `enum` | Static choices from `values`. |
| `model` | Current model profiles supplied by the host UI. |
| `session` | Current session list supplied by the host UI. |
| `path` | Filesystem path input. UIs may offer a picker or plain text. |
| `boolean` | Boolean input. |
| `number` | Numeric input. |

`enum` values look like this:

```ts
args: [
  {
    name: 'level',
    type: 'enum',
    required: false,
    values: [
      { id: '1', name: 'L1', description: 'Facts only' },
      { id: '2', name: 'L2', description: 'Facts and graph' }
    ]
  }
];
```

## Subcommands

Commands may expose one level of subcommands. This is discovery metadata for the composer; the
daemon still invokes the parent command and passes the remaining text as raw args.

```ts
export const memoryCommand = defineCommand({
  name: 'memory',
  description: 'Manage memory',
  subcommands: [
    {
      id: 'check',
      name: 'Check',
      description: 'Check memory contradictions'
    },
    {
      id: 'consolidate',
      name: 'Consolidate',
      description: 'Consolidate memory layers',
      args: [{ name: 'level', type: 'number', required: false, placeholder: '[level]' }]
    }
  ],
  async run(ctx, args) {
    const [subcommand, ...rest] = args.trim().split(/\s+/);
    if (subcommand === 'check') {
      const { flagged } = await ctx.checkMemory();
      return { message: `Flagged ${flagged} contradictions.` };
    }
    if (subcommand === 'consolidate') {
      const level = Number.parseInt(rest[0] ?? '', 10);
      const result = await ctx.consolidate(level >= 1 && level <= 3 ? level : undefined);
      return { message: `Consolidated through level ${result.level}.` };
    }
    return { message: 'Usage: /memory <check|consolidate> [level]' };
  }
});
```

The composer behavior is:

- `/memory ` suggests `check` and `consolidate`.
- `/memory consolidate ` uses the `consolidate.args` metadata for argument suggestions.
- `/memory anything` is still sent to the parent `memory` command; your `run()` function decides
  whether it is valid.

Monad intentionally supports only one subcommand level for now. It does not support nested
subcommand groups or a full flag parser in command metadata.

## Command metadata

```ts
type CommandDefinition = {
  name: string;
  aliases?: string[];
  description: string;
  argHint?: string;
  args?: CommandArg[];
  subcommands?: CommandSubcommand[];
  highRisk?: boolean;
  duringTurn?: boolean;
  run(ctx: CommandRunContext, args: string): Promise<CommandResult>;
};
```

Use `argHint` only when a simple text hint is enough or while migrating older commands. Prefer
`args` for new commands because it enables autocomplete.

## Boundaries

- Built-in command names and aliases are reserved.
- Atom-pack command ids are namespaced as `<pack>.<command>`. The leading `/` is only the composer
  trigger prefix, so users run the command as `/<pack>.<command>`.
- `id` from `/v1/commands` is the canonical slash token clients insert.
- `name` is user-facing display text only.
- The host owns high-risk approval. Set `highRisk: true` when the command can affect local state,
  files, credentials, or external services.
