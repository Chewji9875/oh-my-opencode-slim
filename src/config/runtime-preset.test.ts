import { describe, expect, test } from 'bun:test';
import {
  getActiveRuntimePreset,
  setActiveRuntimePreset,
} from './runtime-preset';

describe('runtime-preset', () => {
  // Cleanup after each test to avoid state leakage
  test('getActiveRuntimePreset returns null initially', () => {
    setActiveRuntimePreset(null);
    expect(getActiveRuntimePreset()).toBeNull();
    setActiveRuntimePreset(null);
  });

  test('setActiveRuntimePreset sets the active preset', () => {
    setActiveRuntimePreset(null);
    setActiveRuntimePreset('foo');
    expect(getActiveRuntimePreset()).toBe('foo');
    setActiveRuntimePreset(null);
  });
});
