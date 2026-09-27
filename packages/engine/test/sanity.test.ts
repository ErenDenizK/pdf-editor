import { expect, test } from 'vitest';

test('runs in a real browser with WebAssembly available', () => {
  expect(typeof WebAssembly).toBe('object');
  expect(typeof window).toBe('object');
});
