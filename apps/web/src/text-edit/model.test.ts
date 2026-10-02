/**
 * The Edit text tool's pure logic (spec §2.2, §2.5): editability → badge, the fit choice,
 * the edited range, blockers, caret placement, screen angle and history labels.
 */
import type {
  LocatedRun,
  TextEditability,
  TextEditResult,
  TextFitOption,
} from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import { m } from '../i18n';
import type { PageFrame } from '../viewer/geometry';
import {
  blockerOfRun,
  editRange,
  familyOfFace,
  fitStateOf,
  fitSummary,
  focusReturnRun,
  fontLine,
  glyphIndexAt,
  glyphSelection,
  historyLabel,
  honestyBadge,
  resolveFit,
  screenAngle,
  singleLine,
} from './model';

const LINE = 'The quick brown fox jumps';

/** A located run of `text` with one glyph per character, 10 pt apart on y = 100. */
function run(text = LINE, patch: Partial<LocatedRun> = {}): LocatedRun {
  return {
    source: 's1' as LocatedRun['source'],
    pageIndex: 0,
    objectPath: [0],
    charStart: 0,
    charCount: text.length,
    text,
    lineBox: { x: 10, y: 98, width: text.length * 10, height: 12 },
    glyphs: Array.from(text, (c, i) => ({
      text: c,
      rect: { x: 10 + i * 10, y: 98, width: 9, height: 12 },
      charIndex: i,
      origin: { x: 10 + i * 10, y: 100 },
    })) as unknown as LocatedRun['glyphs'],
    fontSize: 12,
    matrix: [1, 0, 0, 1, 10, 100],
    direction: { x: 1, y: 0 },
    font: {
      baseName: 'Helvetica',
      embedded: false,
      kind: 'standard14',
      flags: 32,
      bold: false,
      italic: false,
      monospace: false,
      serif: false,
    },
    renderMode: 0,
    inForm: false,
    vertical: false,
    ...patch,
  };
}

function option(width: number, available: number): TextFitOption {
  const fits = width <= available;
  const shrink = fits ? 1 : available / width;
  return { width, shrink, fits, canShrink: shrink >= 0.75 };
}

function check(patch: Partial<TextEditability> = {}): TextEditability {
  return {
    tier2: { ok: true },
    tier1: { ok: true, substitute: 'Inter-Regular', family: 'Inter' },
    tier: 2,
    honesty: 'same-font',
    fit: { available: 30, boundedByGlyph: true, replaced: 20, tier2: option(20, 30) },
    ...patch,
  };
}

/** A report for a run that cannot be edited (no `tier`). */
function blocked(
  tier2: TextEditability['tier2'],
  tier1: TextEditability['tier1'],
): TextEditability {
  const { tier: _tier, ...rest } = check();
  return { ...rest, honesty: 'not-editable', tier2, tier1 };
}

describe('editability → badge', () => {
  it('maps every honesty state to its badge', () => {
    expect(honestyBadge(check())).toEqual({ tone: 'same', label: m.text_edit_badge_same_font() });
    expect(honestyBadge(check({ honesty: 'same-font-not-embedded' }))).toEqual({
      tone: 'info',
      label: 'Same font (not embedded)',
    });
    const substituted = honestyBadge(
      check({
        tier: 1,
        honesty: 'font-substituted',
        tier2: { ok: false, reason: 'missing-glyphs', missing: ['Q'] },
      }),
    );
    expect(substituted).toMatchObject({ tone: 'warning', label: 'Font substituted: Inter' });
    expect(substituted.fellBack).toBe('It has no glyph for “Q”');
    const form = honestyBadge(
      check({
        tier: 1,
        honesty: 'moved-out-of-form',
        tier2: { ok: false, reason: 'in-form', missing: [] },
      }),
    );
    expect(form).toMatchObject({ tone: 'warning', label: 'Moves out of form' });
    expect(form.detail).toContain('Inter');
    // Always tier 1 in a form: that is not a fallback.
    expect(form.fellBack).toBeUndefined();
  });

  it('shows why a run is not editable', () => {
    const type3 = honestyBadge(
      blocked({ ok: false, reason: 'blocked', missing: [] }, { ok: false, reason: 'type3' }),
    );
    expect(type3).toEqual({
      tone: 'blocked',
      label: 'Not editable',
      detail: 'Type3 font (its glyphs are drawings)',
    });
    const unsupported = honestyBadge(
      blocked(
        { ok: false, reason: 'outside-winansi', missing: ['中'] },
        { ok: false, reason: 'unsupported-chars', missing: ['中'] },
      ),
    );
    expect(unsupported.detail).toBe('no bundled font has “中”');
    expect(unsupported.fellBack).toBeUndefined();
  });

  it('reports the tier-2 refusal reason when tier 1 is used', () => {
    const readback = honestyBadge(
      check({
        tier: 1,
        honesty: 'font-substituted',
        tier2: { ok: false, reason: 'readback', missing: ['ÿ'] },
      }),
    );
    expect(readback.fellBack).toContain('did not read back “ÿ”');
    const notEmbedded = honestyBadge(
      check({
        tier: 1,
        honesty: 'font-substituted',
        tier2: { ok: false, reason: 'not-embedded', missing: [] },
      }),
    );
    // The font line already says "not embedded": the badge does not repeat it.
    expect(notEmbedded.fellBack).toBeUndefined();
  });

  it('describes the font and the substitute family', () => {
    expect(fontLine({ baseName: 'Helvetica', embedded: false })).toBe('Helvetica · not embedded');
    expect(fontLine({ baseName: 'FXTAAA+Inter-Regular', embedded: true })).toBe(
      'Inter Regular · embedded',
    );
    expect(fontLine({ baseName: 'TimesNewRomanPSMT', embedded: false })).toBe(
      'Times New Roman · not embedded',
    );
    expect(familyOfFace('Inter-Regular')).toBe('Inter');
    expect(familyOfFace('JetBrainsMono-Regular')).toBe('JetBrains Mono');
    expect(familyOfFace('NotoSerif-Bold')).toBe('Noto Serif');
    expect(familyOfFace(undefined)).toBe('?');
  });
});

describe('fit choice', () => {
  it('keeps the size when the text fits, whatever was chosen', () => {
    const state = fitStateOf(check());
    expect(state).toEqual({ available: 30, needed: 20, fits: true, shrink: 1, canShrink: true });
    expect(resolveFit(state, null)).toBe('keep');
    expect(resolveFit(state, 'overflow')).toBe('keep');
  });

  it('asks for a choice when it does not fit; shrink only above the 75% floor', () => {
    const wide = fitStateOf(check({ fit: { ...check().fit, tier2: option(36, 30) } }));
    expect(wide).toMatchObject({ fits: false, canShrink: true });
    expect(wide?.shrink).toBeCloseTo(30 / 36);
    expect(resolveFit(wide, null)).toBeNull();
    expect(resolveFit(wide, 'shrink')).toBe('shrink');
    expect(resolveFit(wide, 'overflow')).toBe('overflow');
    const wider = fitStateOf(check({ fit: { ...check().fit, tier2: option(60, 30) } }));
    expect(wider).toMatchObject({ fits: false, canShrink: false, shrink: 0.5 });
    // A shrink chosen earlier no longer applies once the text needs more than the floor.
    expect(resolveFit(wider, 'shrink')).toBeNull();
    expect(resolveFit(wider, 'overflow')).toBe('overflow');
  });

  it('says how much too wide the text is in whole percent', () => {
    const wide = fitStateOf(check({ fit: { ...check().fit, tier2: option(36, 30) } }));
    expect(wide && fitSummary(wide)).toBe('20% too wide for the line');
    const barely = fitStateOf(check({ fit: { ...check().fit, tier2: option(30.03, 30) } }));
    // Never "0% too wide": a text that does not fit is at least 1% over.
    expect(barely && fitSummary(barely)).toBe('1% too wide for the line');
  });

  it('measures the tier the edit will use, and nothing when not editable', () => {
    const tier1 = check({
      tier: 1,
      honesty: 'font-substituted',
      tier2: { ok: false, reason: 'missing-glyphs', missing: ['Q'] },
      fit: { available: 30, boundedByGlyph: true, replaced: 20, tier1: option(33, 30) },
    });
    expect(fitStateOf(tier1)).toMatchObject({ needed: 33, fits: false });
    expect(
      fitStateOf(
        blocked({ ok: false, reason: 'blocked', missing: [] }, { ok: false, reason: 'vertical' }),
      ),
    ).toBeUndefined();
    expect(resolveFit(undefined, 'overflow')).toBeNull();
  });
});

describe('edited range', () => {
  it('is undefined when nothing changed', () => {
    expect(editRange(run(), LINE)).toBeUndefined();
  });

  it('replaces whole words around the change', () => {
    expect(editRange(run(), 'The quick brown cat jumps')).toEqual({
      start: 16,
      end: 19,
      replacement: 'cat',
    });
    // One letter changed: the word is replaced (a substitute never starts mid-word).
    expect(editRange(run(), 'The quick brown Fox jumps')).toEqual({
      start: 16,
      end: 19,
      replacement: 'Fox',
    });
    expect(editRange(run(), 'The quick brown foxes jumps')).toEqual({
      start: 16,
      end: 19,
      replacement: 'foxes',
    });
    expect(editRange(run(), 'The quick fox jumps')).toEqual({
      start: 10,
      end: 19,
      replacement: 'fox',
    });
    expect(editRange(run(), 'A quick brown fox jumps')).toEqual({
      start: 0,
      end: 3,
      replacement: 'A',
    });
  });

  it('stays on glyph boundaries (ligatures)', () => {
    const lig = run('office work');
    const glyphs = [...lig.glyphs];
    // "ffi" is one glyph.
    const merged = { ...glyphs[1]!, text: 'ffi' } as LocatedRun['glyphs'][number];
    const ligated = { ...lig, glyphs: [glyphs[0]!, merged, ...glyphs.slice(4)] };
    expect(editRange(ligated, 'offices work')).toEqual({
      start: 0,
      end: 6,
      replacement: 'offices',
    });
  });

  it('keeps edits on one line', () => {
    expect(singleLine('a\nb\r\nc\td')).toBe('a b c d');
  });
});

describe('runs', () => {
  it('tells editable runs from blocked ones', () => {
    expect(blockerOfRun(run())).toBeUndefined();
    expect(blockerOfRun(run(LINE, { objectPath: [3, 1] }))).toBeUndefined();
    expect(blockerOfRun(run(LINE, { font: { ...run().font, kind: 'type3' } }))).toBe('type3');
    expect(blockerOfRun(run(LINE, { renderMode: 3 }))).toBe('invisible');
    expect(blockerOfRun(run(LINE, { vertical: true }))).toBe('vertical');
    expect(blockerOfRun(run(LINE, { objectPath: [3, 1, 0] }))).toBe('nested-form');
  });

  it('selects the clicked glyph', () => {
    const r = run();
    expect(glyphIndexAt(r, { x: 175, y: 104 })).toBe(16);
    // Past the end: the nearest glyph.
    expect(glyphIndexAt(r, { x: 1000, y: 104 })).toBe(LINE.length - 1);
    expect(glyphSelection(r, 16)).toEqual({ start: 16, end: 17 });
    expect(glyphSelection(r, -1)).toEqual({ start: LINE.length, end: LINE.length });
  });

  it('turns the editor with the line on screen', () => {
    const frame = (rotation: 0 | 90 | 180 | 270): PageFrame => ({
      size: { width: 612, height: 792 },
      originX: 0,
      originY: 0,
      rotation,
      scale: 1,
    });
    expect(screenAngle(frame(0), run())).toBe(0);
    expect(screenAngle(frame(90), run())).toBe(90);
    expect(screenAngle(frame(270), run())).toBe(270);
    // A line counter-rotated by its matrix on a /Rotate 90 page reads upright.
    expect(screenAngle(frame(90), run(LINE, { direction: { x: 0, y: 1 } }))).toBe(0);
    expect(screenAngle(frame(0), run(LINE, { direction: { x: -1, y: 0 } }))).toBe(180);
  });
});

describe('history label', () => {
  const result = (patch: Partial<TextEditResult>): TextEditResult => ({
    tier: 2,
    honesty: 'same-font',
    fontSize: 12,
    fellBack: false,
    verification: { readback: 'cat', maxDrift: 0, insideLineBox: true },
    ...patch,
  });

  it('names the honesty state of the applied edit', () => {
    expect(historyLabel(result({}))).toBe('Text edited (same font)');
    expect(historyLabel(result({ honesty: 'same-font-not-embedded' }))).toBe(
      'Text edited (same font, not embedded)',
    );
    expect(
      historyLabel(result({ tier: 1, honesty: 'font-substituted', substitute: 'NotoSerif-Bold' })),
    ).toBe('Text edited (font substituted: Noto Serif)');
    expect(
      historyLabel(
        result({
          tier: 1,
          honesty: 'font-substituted',
          substitute: 'Inter-Regular',
          fellBack: true,
          tier2Refusal: 'readback',
        }),
      ),
    ).toBe('Text edited (fell back, font substituted: Inter)');
    expect(historyLabel(result({ tier: 1, honesty: 'moved-out-of-form' }))).toBe(
      'Text edited (moved out of form)',
    );
  });
});

describe('focus after the editor closes', () => {
  /** A run of `text` starting at (x, y), 10 pt per character, as object `path` from `charStart`. */
  function at(text: string, x: number, y: number, path: number, charStart: number): LocatedRun {
    const base = run(text);
    return {
      ...base,
      objectPath: [path],
      charStart,
      lineBox: { x, y: y - 2, width: text.length * 10, height: 12 },
      glyphs: base.glyphs.map((g, i) => ({
        ...g,
        rect: { ...g.rect, x: x + i * 10, y: y - 2 },
        origin: { x: x + i * 10, y },
      })),
    };
  }

  it('returns to the same run while it is still there (Esc)', () => {
    const line = at(LINE, 10, 100, 0, 0);
    const below = at('Second line', 10, 80, 1, 25);
    expect(focusReturnRun([below, line], line)).toBe(line);
  });

  it('after a commit, the run of the same line nearest to where the edited one started', () => {
    const before = at(LINE, 10, 100, 0, 0);
    // The edit split the line into new objects with new indices.
    const head = at('The quick brown ', 10, 100, 3, 0);
    const word = at('cat', 170, 100, 4, 16);
    const tail = at(' jumps', 200, 100, 5, 19);
    const other = at('Another line', 10, 60, 0, 30);
    expect(focusReturnRun([other, tail, word, head], before)).toBe(head);
    // Only a run further along is left on the line: that one.
    expect(focusReturnRun([other, tail], before)).toBe(tail);
  });

  it('never returns a run of another line, nor one that cannot be edited', () => {
    const before = at(LINE, 10, 100, 0, 0);
    const other = at('Another line', 10, 60, 1, 30);
    const invisible = { ...at('OCR', 10, 100, 2, 40), renderMode: 3 };
    // Same key but on another line (object indices shifted): not the edited line.
    const shifted = at('Moved', 10, 40, 0, 0);
    expect(focusReturnRun([other, invisible, shifted], before)).toBeUndefined();
  });
});
