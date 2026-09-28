/**
 * Tesseract's glyphless font `pdf.ttf` (Apache-2.0, tesseract-ocr/tessconfigs `3decf1c8`,
 * byte-identical to tesseract/tessdata/pdf.ttf; pinned in `ocr/langs.lock.json`
 * `glyphlessFont`, checked by the engine tests, layer.test.ts): 572 bytes, two glyphs, GID 1
 * advance 1024/2048 em with a box of 0…1024 × 0…2048. Embedded here so the layer writer never
 * fetches.
 */

/** SHA-256 of the font file (as in `langs.lock.json`). */
export const GLYPHLESS_FONT_SHA256 =
  'c7845420925a23d88ed830a63957b8af85a66a8daf8d9fc90e843673b2ef1a59';

const BASE64 =
  'AAEAAAAKAIAAAwAgT1MvMlbeyJQAAAEoAAAAYGNtYXAACgA0AAABkAAAAB5nbHlmFSJBJAAAAbgAAAAYaGVhZAt4' +
  '8WUAAACsAAAANmhoZWEMAgQCAAAA5AAAACRobXR4BAAAAAAAAYgAAAAIbG9jYQAMAAAAAAGwAAAABm1heHAABAAF' +
  'AAABCAAAACBuYW1l8usW2gAAAdAAAABLcG9zdAABAAEAAAIcAAAAIAABAAAAAQAAsJRxEF8PPPUEBwgAAAAAAM+a' +
  '/G4AAAAA1MOn8gAAAAAEAAgAAAAAEAACAAAAAAAAAAEAAAgA//8AAAQAAAAAAAQAAAEAAAAAAAAAAAAAAAAAAAAC' +
  'AAEAAAACAAQAAQAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAwAAAZAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUA' +
  'AQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAR09PRwBAAAAAAAAB//8AAAABAAGAAAAAAAAAAAAAAAAAAAABAAAAAAAA' +
  'BAAAAAAAAAIAAQAAAAAAFAADAAAAAAAUAAYACgAAAAAAAAAAAAAAAAAMAAAAAQAAAAAEAAgAAAMAADEhESEEAPwA' +
  'CAAAAAADACoAAAADAAAABQAWAAAAAQAAAAAABQALABYAAwABBAkABQAWAAAAVgBlAHIAcwBpAG8AbgAgADEALgAw' +
  'VmVyc2lvbiAxLjAAAAEAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=';

/** The font file's bytes (a fresh copy). */
export function glyphlessFontBytes(): Uint8Array {
  const binary = atob(BASE64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
