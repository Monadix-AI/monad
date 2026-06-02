import type { CommandDef } from './types.ts';

import { command as acp } from './acp.ts';
import { command as agent } from './agent.ts';
import { command as appServer } from './app-server.ts';
import { command as approval } from './approval.ts';
import { command as atom } from './atom.ts';
import { command as channel } from './channel.ts';
import { command as chat } from './chat.ts';
import { command as commandCmd } from './command.ts';
import { command as complete } from './complete.ts';
import { command as completion } from './completion.ts';
import { command as config } from './config.ts';
import { command as credential } from './credential.ts';
import { command as doctor } from './doctor.ts';
import { command as importCmd } from './import.ts';
import { command as init } from './init.ts';
import { command as license } from './license.ts';
import { command as logs } from './logs.ts';
import { command as mcp } from './mcp.ts';
import { command as memory } from './memory.ts';
import { command as mesh } from './mesh.ts';
import { command as model } from './model.ts';
import { command as monadix } from './monadix.ts';
import { command as nativeAgent } from './native-agent.ts';
import { command as peer } from './peer.ts';
import { command as provider } from './provider.ts';
import { command as purge } from './purge.ts';
import { command as remote } from './remote.ts';
import { command as restart } from './restart.ts';
import { command as session } from './session.ts';
import { shortcutCommands } from './shortcuts.ts';
import { command as skill } from './skill.ts';
import { command as start } from './start.ts';
import { command as status } from './status.ts';
import { command as stop } from './stop.ts';
import { command as tui } from './tui.ts';
import { command as upgrade } from './upgrade.ts';
import { command as usage } from './usage.ts';
import { command as version } from './version.ts';

export type { CommandDef };

// Registration order is the order the usage table prints within each `group`. The groups answer
// "what am I trying to do", which is what a reader scans for — not whether a command happens to
// need a daemon connection.
export const commands: CommandDef[] = [
  // Run and inspect the daemon.
  start,
  stop,
  restart,
  status,
  logs,
  doctor,
  upgrade,
  version,

  // Do the work: talk to agents, run the team, unblock it.
  chat,
  session,
  agent,
  mesh,
  approval,

  // Set the daemon up.
  init,
  config,
  model,
  provider,
  credential,
  atom,
  skill,
  mcp,
  memory,
  commandCmd,
  channel,
  peer,
  remote,
  monadix,
  importCmd,
  usage,
  license,
  completion,
  purge,
  tui,

  // Hidden: machine/advanced entry points and friendly aliases.
  acp,
  appServer,
  nativeAgent,
  complete,
  ...shortcutCommands
];
