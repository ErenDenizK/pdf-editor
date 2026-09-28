/**
 * Applying redactions end to end (spec redaction §1.2, research 06 §3), on the hosted engine
 * and never on the user's open document:
 *
 * 0. capture: the glyph text under each area (strings of 4+ characters) joins the plan's
 *    strings, which are then scrubbed and checked document-wide;
 * 1–2. engine pass on a private scratch document (engine-pass.ts);
 * 3. pdf-lib scrub without the fill (scrub.ts), so the gate sees what is really left;
 * 4. blank-region gate on a fresh scratch of the scrubbed bytes (gate.ts);
 * 5. fill and overlay text (`fillRedactionAreas`);
 * 6. forensic self-check on the exact final bytes, with dependencies bound to another fresh
 *    scratch of them.
 *
 * Fails closed: when the gate or the check fails it throws `RedactionFailedError` (an
 * `EngineError`) carrying every report, never the bytes.
 */

import type { Rect } from '@pdf-editor/document-model';

import { runTask } from '../pdfium/task-bridge';
import {
  type ApplyRedactionsOptions,
  type ApplyRedactionsResult,
  EngineError,
  type RedactionCapture,
  type RedactionPlan,
} from '../types';
import { runEnginePass } from './engine-pass';
import {
  openScratch,
  type PageChar,
  type RedactionHost,
  type ScratchDocument,
  withForensicDeps,
} from './engine-session';
import { forensicCheck } from './forensic';
import { blankRegionGate } from './gate';
import { intersects } from './pdf-util';
import { fillRedactionAreas, scrubRedactedDocument } from './scrub';
import { normalizeForMatch } from './strings';

/** Captured strings shorter than this (normalised) are not searched document-wide. */
export const MIN_CAPTURED_LENGTH = 4;

/** What was known when a redaction failed its gate or its check (no bytes). */
export type RedactionFailure = Partial<Omit<ApplyRedactionsResult, 'bytes'>> &
  Pick<ApplyRedactionsResult, 'plan' | 'captured'>;

/**
 * A redaction that must not be offered: `stage` says which gate stopped it and `failure`
 * holds the reports (the gate's areas, or the forensic findings).
 */
export class RedactionFailedError extends EngineError {
  constructor(
    readonly stage: 'gate' | 'forensic',
    message: string,
    readonly failure: RedactionFailure,
  ) {
    super(stage === 'gate' ? 'unsupported' : 'internal', message);
    this.name = 'RedactionFailedError';
  }
}

/** Glyph rects are whole points: a glyph must overlap an area by more than 1 pt. */
function probe(rect: Rect): Rect {
  const dx = Math.min(1, rect.width / 4);
  const dy = Math.min(1, rect.height / 4);
  return {
    x: rect.x + dx,
    y: rect.y + dy,
    width: rect.width - 2 * dx,
    height: rect.height - 2 * dy,
  };
}

/** Contiguous glyph text inside `rect`, one string per line. */
export function textUnder(chars: readonly PageChar[], rect: Rect): string[] {
  const p = probe(rect);
  const out: string[] = [];
  let current = '';
  let open = false;
  const flush = () => {
    if (current.trim() !== '') out.push(current.trim());
    current = '';
    open = false;
  };
  for (const c of chars) {
    if (!c.rect) {
      if (/[\r\n]/.test(c.text)) flush();
      else if (open) current += c.text;
    } else if (intersects(c.rect, p)) {
      current += c.text;
      open = true;
    } else if (open) flush();
  }
  flush();
  return out;
}

async function capture(scratch: ScratchDocument, plan: RedactionPlan): Promise<RedactionCapture> {
  const strings = new Set<string>();
  const skipped = new Set<string>();
  const cache = new Map<number, PageChar[]>();
  for (const area of plan.areas) {
    let chars = cache.get(area.pageIndex);
    if (!chars) {
      chars = await scratch.chars(area.pageIndex);
      cache.set(area.pageIndex, chars);
    }
    for (const s of textUnder(chars, area.rect)) {
      (normalizeForMatch(s).length >= MIN_CAPTURED_LENGTH ? strings : skipped).add(s);
    }
  }
  return { strings: [...strings], skipped: [...skipped] };
}

/**
 * Applies `plan` to `bytes` (a source, possibly encrypted) and returns verified redacted
 * bytes with every report. Throws `RedactionFailedError` when the blank-region gate or the
 * forensic self-check fails, and `EngineError` for a bad plan, password or file.
 */
export async function applyRedactions(
  host: RedactionHost,
  bytes: ArrayBuffer | Uint8Array,
  plan: RedactionPlan,
  options: ApplyRedactionsOptions = {},
): Promise<ApplyRedactionsResult> {
  const { signal } = options;
  const started = performance.now();
  const scratch = await openScratch(host, bytes, {
    ...(options.password === undefined ? {} : { password: options.password }),
    ...(signal ? { signal } : {}),
  });
  let captured: RedactionCapture = { strings: [], skipped: [] };
  let applied: RedactionPlan = plan;
  let engineBytes: ArrayBuffer;
  let engine;
  try {
    if (options.captureStrings !== false) {
      // Areas are validated by the engine pass; capture only reads valid pages.
      const valid = plan.areas.filter(
        (a) => a.pageIndex >= 0 && a.pageIndex < scratch.doc.pageCount,
      );
      captured = await capture(scratch, { ...plan, areas: valid });
      const known = new Set(plan.strings.map(normalizeForMatch));
      applied = {
        ...plan,
        strings: [
          ...plan.strings,
          ...captured.strings.filter((s) => !known.has(normalizeForMatch(s))),
        ],
      };
    }
    engine = await runEnginePass(host, scratch, applied, {
      ...(options.removeCoveredImages === undefined
        ? {}
        : { removeCoveredImages: options.removeCoveredImages }),
      ...(signal ? { signal } : {}),
    });
    engineBytes = await runTask(host.engine.saveAsCopy(scratch.doc), signal, { op: 'save' });
  } finally {
    await scratch.close();
  }
  const engineReport = { ...engine, durationMs: performance.now() - started };

  const scrubbed = await scrubRedactedDocument(engineBytes, applied, { fill: false });
  const gateScratch = await openScratch(host, scrubbed.bytes, signal ? { signal } : {});
  let gate;
  try {
    gate = await blankRegionGate(host, gateScratch, applied, signal);
  } finally {
    await gateScratch.close();
  }
  if (!gate.ok) {
    const failing = gate.areas.filter((a) => !a.blank);
    throw new RedactionFailedError(
      'gate',
      `Redaction left visible content in ${failing.length} area(s): ${failing
        .map((a) => `page ${a.pageIndex + 1} area ${a.areaIndex} (${a.remaining.join(', ')})`)
        .join('; ')}`,
      { plan: applied, captured, engine: engineReport, gate, redaction: scrubbed.report },
    );
  }

  const filled = await fillRedactionAreas(scrubbed.bytes, applied);
  const redaction = {
    ...scrubbed.report,
    warnings: [...scrubbed.report.warnings, ...filled.warnings],
  };
  const forensic = await withForensicDeps(
    host,
    filled.bytes,
    (deps) => forensicCheck(filled.bytes, applied, deps),
    signal ? { signal } : {},
  );
  if (!forensic.ok) {
    const failed = forensic.checks.filter((c) => !c.passed).map((c) => c.id);
    throw new RedactionFailedError(
      'forensic',
      `The redacted file failed the self-check (${failed.join(', ')})`,
      { plan: applied, captured, engine: engineReport, gate, redaction, forensic },
    );
  }
  return {
    bytes: filled.bytes,
    plan: applied,
    captured,
    engine: engineReport,
    gate,
    redaction,
    forensic,
  };
}
