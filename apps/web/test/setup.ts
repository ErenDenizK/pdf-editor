// Shared setup for component tests (Vitest browser mode).
// - Registers the jest-dom matchers (`toBeVisible`, `toHaveAccessibleName`, ...) on
//   Vitest's `expect`, including their types.
// - Unmounts React trees rendered with @testing-library/react after every test, since
//   Vitest globals are off and automatic cleanup therefore does not register itself.
// - Forgets the remembered reading position before every test. Browser mode runs every
//   test file in a same-origin iframe of one browser, so they share one localStorage; a
//   file that leaves a fixture remembered at a later page would otherwise make the next
//   file's Read view open there, with page 1 off screen and its annotation layer unloaded.
// - Keeps Recents in memory, empty at the start of every test. Every open records a Recent,
//   so with the default IndexedDB store each of the many test iframes opened and wrote one
//   shared database; under that load CI's Chromium 153 browser process crashed (SIGTRAP)
//   part-way through the suite. recents.test.ts opens its own databases where IndexedDB
//   itself is under test.
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { memoryRecentsBackend, setRecentsBackend } from '../src/files/recents';
import { POSITIONS_KEY } from '../src/viewer/navigation';

beforeEach(() => {
  // A file opened by one test never shows as a Recent row on another test's Home.
  setRecentsBackend(memoryRecentsBackend());
  localStorage.removeItem(POSITIONS_KEY);
  // Per-device settings written by a test (pen seen, presets, appearance) must not leak
  // into the next file either.
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('pdf-editor:')) localStorage.removeItem(key);
  }
});

afterEach(() => {
  cleanup();
});
