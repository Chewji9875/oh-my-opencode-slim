import type { PluginInput } from '@opencode-ai/plugin';

/**
 * Returns the in-process OpenCode client for the given plugin directory.
 * The plugin host provides `input.client` — a direct in-process client into
 * the same OpenCode server the plugin runs inside. No loopback HTTP is
 * involved. Keyed by directory; the server holds session state so a cached
 * client stays valid for the process lifetime.
 */
export function getClient(input: PluginInput): PluginInput['client'] {
  return input.client;
}