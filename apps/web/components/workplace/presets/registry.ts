import type { PresetDefinition } from './types';

import { chatPreset } from './chat/ChatPreset';
import { graphPreset } from './graph/GraphPreset';

// Built-in presets, compiled into the app. Atom-contributed presets (future `view` atom) would be
// merged on top at runtime — the same builtin+discovered shape channels/commands use.
const BUILTINS: PresetDefinition[] = [chatPreset, graphPreset];

// The presets a user can switch between (drives the top-bar toggle). Adding a preset here — or a
// future atom-contributed one — makes it appear in the switcher automatically.
export function listPresets(): PresetDefinition[] {
  return BUILTINS;
}

// Resolve a view id to its preset, falling back to chat when it's unknown (e.g. an atom preset
// that has since been uninstalled).
export function getPreset(id: string | undefined): PresetDefinition {
  return BUILTINS.find((p) => p.id === id) ?? chatPreset;
}
