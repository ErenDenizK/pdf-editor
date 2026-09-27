/**
 * qpdf command lines for `PlumberOptions` (ADR-0008). Pure: the worker runs them against
 * MEMFS paths. Every job is a full rewrite (no `--qdf`), which is also what repairs a
 * damaged file: qpdf rebuilds the cross-reference table while reading and writes a clean
 * one.
 */
import type { PermissionFlags, SecurityPolicy } from '@pdf-editor/document-model';

import type { PlumberOptions } from '../types';

export const QPDF_INPUT = '/work/in.pdf';
export const QPDF_OUTPUT = '/work/out.pdf';

/** Largest input accepted: MEMFS holds the input and the output in the wasm heap (4 GB). */
export const MAX_PLUMBER_INPUT_BYTES = 512 * 1024 * 1024;

function yn(value: boolean): 'y' | 'n' {
  return value ? 'y' : 'n';
}

/**
 * qpdf 12 `--encrypt` (the long form, which allows an empty user password) for AES-256.
 * Permission names follow the qpdf manual, "Encryption": --print=full|low|none,
 * --modify=all|annotate|form|assembly|none plus the finer --extract, --annotate, --form,
 * --assemble and --accessibility flags.
 */
export function encryptArgs(policy: SecurityPolicy): string[] {
  const p: PermissionFlags = policy.permissions;
  const print = p.print ? (p.printHighQuality ? 'full' : 'low') : 'none';
  return [
    '--encrypt',
    `--user-password=${policy.userPassword ?? ''}`,
    // qpdf refuses an empty owner password with a non-empty user password only when
    // --allow-weak-crypto is missing for R<6; for AES-256 an empty owner is accepted, but a
    // random owner makes the permissions meaningful, so callers should always pass one.
    `--owner-password=${policy.ownerPassword ?? ''}`,
    '--bits=256',
    `--print=${print}`,
    `--modify=${p.modify ? 'all' : 'none'}`,
    `--extract=${yn(p.copy)}`,
    `--annotate=${yn(p.annotate)}`,
    `--form=${yn(p.fillForms)}`,
    `--assemble=${yn(p.assemble)}`,
    `--accessibility=${yn(p.accessibility)}`,
    '--',
  ];
}

/** `PlumberOptions` plus the password of an encrypted input that stays encrypted. */
export interface QpdfJobOptions extends PlumberOptions {
  readonly password?: string;
}

/** Arguments of one rewrite job (without the program name). */
export function qpdfArgs(options: QpdfJobOptions = {}): string[] {
  const args: string[] = [];
  if (options.decrypt) {
    if (options.decrypt.password !== undefined) args.push(`--password=${options.decrypt.password}`);
    args.push('--decrypt');
  } else if (options.password !== undefined) {
    args.push(`--password=${options.password}`);
  }
  if (options.objectStreams) args.push(`--object-streams=${options.objectStreams}`);
  if (options.recompressFlate) args.push('--recompress-flate', '--compression-level=9');
  if (options.removeUnreferencedResources) args.push('--remove-unreferenced-resources=yes');
  if (options.linearize) args.push('--linearize');
  if (options.encrypt) args.push(...encryptArgs(options.encrypt));
  // Exit status 3 ("succeeded with warnings") is a success; warnings are collected.
  args.push(QPDF_INPUT, QPDF_OUTPUT);
  return args;
}

/** Arguments of a structural check (`qpdf --check`). */
export function qpdfCheckArgs(password?: string): string[] {
  return [...(password === undefined ? [] : [`--password=${password}`]), '--check', QPDF_INPUT];
}

/** qpdf exit statuses (qpdf manual, "Exit Status"). */
export const QPDF_EXIT = { ok: 0, error: 2, warnings: 3 } as const;

/**
 * Warnings qpdf prints while recovering a damaged file. Any of them means the output was
 * rebuilt rather than copied, i.e. the input needed repair.
 */
const REPAIR_PATTERNS: readonly RegExp[] = [
  /file is damaged/i,
  /reconstruct(ing)? cross.?reference/i,
  /xref not found/i,
  /can't find startxref/i,
  /can't find PDF header/i,
  /invalid xref/i,
  /stream keyword followed/i,
  /expected endstream/i,
  /stream length/i,
  /loop detected/i,
];

export function indicatesRepair(warnings: readonly string[]): boolean {
  return warnings.some((line) => REPAIR_PATTERNS.some((pattern) => pattern.test(line)));
}

/**
 * Normalizes qpdf's stderr lines: drops the program-name prefix and the MEMFS path so the
 * UI can show them (e.g. `WARNING: /work/in.pdf: file is damaged` → `file is damaged`).
 */
export function cleanWarning(line: string): string {
  return line
    .replace(/^(qpdf|this\.program):\s*/, '')
    .replace(/^WARNING:\s*/, '')
    .replaceAll(QPDF_INPUT, 'input')
    .replaceAll(QPDF_OUTPUT, 'output')
    .replace(/^input:\s*/, '')
    .trim();
}
