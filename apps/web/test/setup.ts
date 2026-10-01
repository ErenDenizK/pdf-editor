// Shared setup for component tests (Vitest browser mode).
// - Registers the jest-dom matchers (`toBeVisible`, `toHaveAccessibleName`, ...) on
//   Vitest's `expect`, including their types.
// - Unmounts React trees rendered with @testing-library/react after every test, since
//   Vitest globals are off and automatic cleanup therefore does not register itself.
// - Forgets the remembered reading position before every test. Browser mode runs every
//   test file in a same-origin iframe of one browser, so they share one localStorage; a
//   file that leaves a fixture remembered at a later page would otherwise make the next
//   file's Read view open there, with page 1 off screen and its annotation layer unloaded.
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { POSITIONS_KEY } from '../src/viewer/navigation';

beforeEach(() => {
  localStorage.removeItem(POSITIONS_KEY);
});

afterEach(() => {
  cleanup();
});
