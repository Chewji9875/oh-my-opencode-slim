/**
 * Module-level runtime preset state.
 *
 * Survives plugin re-inits triggered by client.config.update() →
 * Instance.dispose(). The plugin function re-runs but this module-level
 * variable persists within the same Node.js process.
 */

let activeRuntimePreset: string | null = null;

export function setActiveRuntimePreset(name: string | null): void {
  activeRuntimePreset = name;
}

export function getActiveRuntimePreset(): string | null {
  return activeRuntimePreset;
}

/**
 * Returns the name of the previously active runtime preset (before the
 * current one), used to compute reset diffs when switching presets.
 */
const previousRuntimePreset: string | null = null;

export function getPreviousRuntimePreset(): string | null {
  return previousRuntimePreset;
}
