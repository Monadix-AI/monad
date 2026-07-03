import type { CommandDef } from './types.ts';

import { command as acp } from './acp.ts';
import { agentCommand, projectCommand, runtimeCommand } from './agent-facing.ts';
import { command as approvals } from './approvals.ts';
import { command as atom } from './atom.ts';
import { command as channel } from './channel.ts';
import { command as chat } from './chat.ts';
import { command as commandsCmd } from './commands.ts';
import { command as complete } from './complete.ts';
import { command as completion } from './completion.ts';
import { command as config } from './config.ts';
import { command as credential } from './credential.ts';
import { command as doctor } from './doctor.ts';
import { command as importCmd } from './import.ts';
import { command as init } from './init.ts';
import { command as licenses } from './licenses.ts';
import { command as logs } from './logs.ts';
import { command as mcp } from './mcp.ts';
import { command as model } from './model.ts';
import { command as nativeAgent } from './native-agent.ts';
import { command as pair } from './pair.ts';
import { command as peer } from './peer.ts';
import { command as provider } from './provider.ts';
import { command as purge } from './purge.ts';
import { command as reset } from './reset.ts';
import { command as restart } from './restart.ts';
import { command as session } from './session.ts';
import { shortcutCommands } from './shortcuts.ts';
import { command as skill } from './skill.ts';
import { command as start } from './start.ts';
import { command as status } from './status.ts';
import { command as stop } from './stop.ts';
import { command as tls } from './tls.ts';
import { command as tui } from './tui.ts';
import { command as upgrade } from './upgrade.ts';
import { command as usage } from './usage.ts';
import { command as version } from './version.ts';

export type { CommandDef };

export const commands: CommandDef[] = [
  // Local commands — run without daemon
  start,
  stop,
  restart,
  logs,
  config,
  pair,
  upgrade,
  completion,
  purge,
  tls,
  version,
  reset,
  acp, // hidden
  // Daemon commands — require a live daemon connection
  status,
  doctor,
  init,
  importCmd,
  chat,
  channel,
  peer,
  session,
  projectCommand,
  agentCommand,
  runtimeCommand,
  model,
  provider,
  nativeAgent,
  credential,
  approvals,
  atom,
  skill,
  mcp,
  commandsCmd,
  usage,
  licenses,
  tui,
  complete, // hidden
  ...shortcutCommands
];
