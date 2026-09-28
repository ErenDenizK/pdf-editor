import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RESULTS } from './pki';

/** Writes a spike's evidence (JSON and a Markdown table) under test-results/. */
export function writeResult(name: string, json: unknown, markdown: string): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(join(RESULTS, `${name}.md`), `${markdown}\n`);
}

export function table(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const line = (cells: readonly unknown[]) => `| ${cells.map((c) => String(c)).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
