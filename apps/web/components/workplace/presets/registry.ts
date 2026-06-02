import type { PresetDefinition } from './types';

import { chatPreset } from './chat/ChatPreset';
import { graphPreset } from './graph/GraphPreset';

const _DEFAULT_PRESET_ID = 'chat';

// Built-in presets, compiled into the app. Atom-contributed presets (future `view` atom) would be
// merged on top at runtime — the same builtin+discovered shape channels/commands use.
const BUILTINS: PresetDefinition[] = [chatPreset, graphPreset];

function _listPresets(): PresetDefinition[] {
  return BUILTINS;
}

// Resolve a persisted preset id, falling back to the default when it's unknown (e.g. an atom preset
// that has since been uninstalled).
export function getPreset(id: string | undefined): PresetDefinition {
  return BUILTINS.find((p) => p.id === id) ?? chatPreset;
}
