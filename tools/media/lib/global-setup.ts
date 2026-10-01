/**
 * Runs once before the scenes: starts a fresh request log, so the published log covers
 * exactly one run (spec §2.3, §8 "Privacy").
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { OUT_DIR, REQUEST_LOG } from './paths.ts';

export default function globalSetup(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    REQUEST_LOG,
    '# Every request the media scenes made: scene, method, URL. Only the preview origin.\n',
  );
}
