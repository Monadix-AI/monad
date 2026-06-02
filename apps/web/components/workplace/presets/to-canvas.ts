import type { ProjectController } from '../use-project';
import type { ProjectCanvas } from './types';

// Derive the read-only canvas a preset receives from the full controller the host holds. Picks the
// display fields + the two host-provided passthrough callbacks; deliberately drops every management
// and communication action so a preset is structurally incapable of either.
export function toCanvas(c: ProjectController): ProjectCanvas {
  return {
    ready: c.ready,
    messages: c.messages,
    participants: c.participants,
    activity: c.activity,
    tasks: c.tasks,
    typing: c.typing,
    firstItemIndex: c.firstItemIndex,
    loadOlder: c.loadOlder,
    sendNativeCliInput: c.sendNativeCliInput,
    stopNativeCli: c.stopNativeCli
  };
}
