import { describe, expect, it } from 'vitest';

import { isExternalRequest } from './external-requests';

const origin = 'https://example.github.io';

describe('isExternalRequest', () => {
  it.each([
    ['https://example.github.io/pdf-editor/assets/app.js', false],
    ['/pdf-editor/assets/font.woff2', false],
    ['assets/relative.wasm', false],
    ['https://fonts.googleapis.com/css2?family=Inter', true],
    ['http://example.github.io/app.js', true],
    ['https://cdn.example.github.io/app.js', true],
    ['wss://sync.example.com/socket', true],
    ['data:font/woff2;base64,AAAA', false],
    ['blob:https://example.github.io/9b1d-uuid', false],
    ['chrome-extension://abc/script.js', false],
    ['http://[invalid', false],
  ])('%s -> %s', (url, expected) => {
    expect(isExternalRequest(url, origin)).toBe(expected);
  });
});
