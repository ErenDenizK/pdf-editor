// Shared setup for component tests (Vitest browser mode).
// - Registers the jest-dom matchers (`toBeVisible`, `toHaveAccessibleName`, ...) on
//   Vitest's `expect`, including their types.
// - Unmounts React trees rendered with @testing-library/react after every test, since
//   Vitest globals are off and automatic cleanup therefore does not register itself.
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
