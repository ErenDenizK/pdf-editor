/**
 * The export's redaction check: `forensicCheck` on the exact final bytes (after assembly,
 * compression and encryption), for every redacted source's plan mapped to output pages
 * (`ExportPlan.redaction.plans`).
 *
 * Plans are grouped by what the pixel check compares against (fill and overlay colour);
 * each group runs once, with every plan-level overlay text moved onto its areas. Redacted
 * strings are document-wide, so they are checked once, with the first group. The reports
 * are merged check by check: a check passes when it passed in every run.
 */

import type {
  ForensicCheckResult,
  ForensicDeps,
  ForensicReport,
  RedactionArea,
  RedactionPlan,
} from '../types';
import { forensicCheck, type ForensicOptions } from './forensic';
import { BLACK, contrastingColor, parseColor } from './pdf-util';

const MAX_FINDINGS = 50;

function colourKey(plan: RedactionPlan): string {
  const fill = parseColor(plan.fillColor) ?? BLACK;
  const overlay = parseColor(plan.overlayColor) ?? contrastingColor(fill);
  return [...fill, ...overlay].map((c) => Math.round(c * 255)).join(',');
}

/** Merges reports of the same bytes: one entry per check id, in the first report's order. */
export function mergeForensicReports(reports: readonly ForensicReport[]): ForensicReport {
  const first = reports[0];
  if (!first) return { ok: true, checks: [], notSearched: [], unverifiedAttachments: [] };
  const checks: ForensicCheckResult[] = first.checks.map((check) => {
    const all = reports.flatMap((r) => r.checks.filter((c) => c.id === check.id));
    const findings = all.flatMap((c) => c.findings);
    const notes = [...new Set(all.flatMap((c) => (c.note === undefined ? [] : [c.note])))];
    return {
      id: check.id,
      passed: all.every((c) => c.passed),
      findings: findings.slice(0, MAX_FINDINGS),
      ...(findings.length > MAX_FINDINGS || all.some((c) => c.truncated)
        ? { truncated: true }
        : {}),
      ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
    };
  });
  return {
    ok: checks.every((c) => c.passed),
    checks,
    notSearched: [...new Set(reports.flatMap((r) => r.notSearched))],
    unverifiedAttachments: [...new Set(reports.flatMap((r) => r.unverifiedAttachments))],
  };
}

/**
 * Checks `finalBytes` against every plan (areas in output page indices). `deps` must be
 * bound to the same bytes (e.g. `withForensicDeps` on the PDFium host, with the password).
 * Never throws; with no plans it still checks the file structure (single revision, no
 * unreachable objects).
 */
export async function verifyRedactedOutput(
  finalBytes: ArrayBuffer | Uint8Array,
  plans: readonly RedactionPlan[],
  deps: ForensicDeps,
  options: ForensicOptions = {},
): Promise<ForensicReport> {
  const strings = [...new Set(plans.flatMap((p) => p.strings))];
  const groups = new Map<string, { plan: RedactionPlan; areas: RedactionArea[] }>();
  for (const plan of plans) {
    const key = colourKey(plan);
    const group = groups.get(key) ?? { plan, areas: [] };
    for (const area of plan.areas) {
      const overlayText = area.overlayText ?? plan.overlayText;
      group.areas.push({
        pageIndex: area.pageIndex,
        rect: area.rect,
        ...(overlayText === undefined ? {} : { overlayText }),
      });
    }
    groups.set(key, group);
  }
  const runs: RedactionPlan[] = [...groups.values()].map(({ plan, areas }, index) => ({
    areas,
    strings: index === 0 ? strings : [],
    ...(plan.fillColor === undefined ? {} : { fillColor: plan.fillColor }),
    ...(plan.overlayColor === undefined ? {} : { overlayColor: plan.overlayColor }),
  }));
  if (runs.length === 0) runs.push({ areas: [], strings });
  const reports: ForensicReport[] = [];
  for (const run of runs) reports.push(await forensicCheck(finalBytes, run, deps, options));
  return mergeForensicReports(reports);
}
