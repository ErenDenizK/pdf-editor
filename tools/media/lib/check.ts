/**
 * `pnpm check`: the media budgets (spec §2.4, §8 "Image budgets"). Prints one row per
 * published file with its size, limit and share of it, then the README's first-view
 * total, and exits non-zero on any file over its limit, any budgeted file that is missing,
 * or any published file without a budget (so a new output cannot skip the check).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { BUDGETS_FILE, MEDIA_DIR } from './paths.ts';

interface Budgets {
  readonly files: Readonly<Record<string, number>>;
  readonly readme: { readonly limit: number; readonly files: readonly string[] };
}

/** Not media: published beside it, never budgeted. */
const UNBUDGETED = new Set(['requests.log']);

const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;

function main(): number {
  const budgets = JSON.parse(readFileSync(BUDGETS_FILE, 'utf8')) as Budgets;
  const present = existsSync(MEDIA_DIR)
    ? readdirSync(MEDIA_DIR).filter((name) => !UNBUDGETED.has(name))
    : [];
  const names = [...new Set([...Object.keys(budgets.files), ...present])].sort();
  const sizes = new Map<string, number>();
  const rows: string[][] = [];
  let failures = 0;

  for (const name of names) {
    const limit = budgets.files[name];
    const path = join(MEDIA_DIR, name);
    const size = existsSync(path) ? statSync(path).size : undefined;
    if (size !== undefined) sizes.set(name, size);
    let status: string;
    if (limit === undefined) status = 'NO BUDGET';
    else if (size === undefined) status = 'MISSING';
    else status = size <= limit ? 'ok' : 'OVER';
    if (status !== 'ok') failures += 1;
    const share = size !== undefined && limit ? `${Math.round((size / limit) * 100)}%` : '';
    rows.push([
      name,
      size === undefined ? '-' : kb(size),
      limit === undefined ? '-' : kb(limit),
      share,
      status,
    ]);
  }

  const readmeTotal = budgets.readme.files.reduce((sum, name) => sum + (sizes.get(name) ?? 0), 0);
  const readmeOk = readmeTotal <= budgets.readme.limit;
  if (!readmeOk) failures += 1;
  rows.push([
    `README first view (${budgets.readme.files.length} files)`,
    kb(readmeTotal),
    kb(budgets.readme.limit),
    `${Math.round((readmeTotal / budgets.readme.limit) * 100)}%`,
    readmeOk ? 'ok' : 'OVER',
  ]);

  const header = ['file', 'size', 'budget', 'used', 'status'];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) =>
        column === 0 || column === 4
          ? cell.padEnd(widths[column] ?? 0)
          : cell.padStart(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd();
  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
  if (failures > 0) console.error(`\n${failures} budget problem(s).`);
  return failures > 0 ? 1 : 0;
}

process.exitCode = main();
