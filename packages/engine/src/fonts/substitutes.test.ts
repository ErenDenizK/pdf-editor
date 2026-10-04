/**
 * The substitute decision (craft spec §4.5): the class of representative font descriptors, the
 * order faces are tried in, the standard-14 metrics and the x-height scale.
 */
import fontkit from '@cantoo/fontkit';
import { describe, expect, test } from 'vitest';

import { panoseOfProgram } from '../text-edit/fonts';
import { bundledFontUrl } from './bundled-fonts';
import { BUNDLED_FACES } from './font-catalog';
import {
  bundledFamilyOfFont,
  faceFamilyName,
  type FontClassFacts,
  standardFontMetrics,
  SUBSTITUTE_SCALE_MAX,
  SUBSTITUTE_SCALE_MIN,
  substituteCandidates,
  substituteClass,
  substituteScale,
} from './substitutes';

const FIXED = 1;
const SERIF = 2;
const SYMBOLIC = 4;
const NONSYMBOLIC = 32;
const ITALIC = 64;

/** PANOSE bytes: Latin text with a serif style and a proportion. */
function panose(serifStyle: number, proportion = 3): number[] {
  return [2, serifStyle, 5, proportion, 0, 0, 0, 0, 0, 0];
}

describe('substituteClass', () => {
  const cases: readonly [string, FontClassFacts, 'serif' | 'mono' | 'sans'][] = [
    // Flags alone.
    ['the Serif flag', { baseName: 'ABCDEF+F1', flags: SERIF | NONSYMBOLIC }, 'serif'],
    ['the FixedPitch flag', { baseName: 'ABCDEF+F2', flags: FIXED | SYMBOLIC }, 'mono'],
    ['no flag, no hint', { baseName: 'ABCDEF+F3', flags: SYMBOLIC }, 'sans'],
    // Standard 14 (no flags in the PDF, only the name).
    ['Times-Roman', { baseName: 'Times-Roman', flags: NONSYMBOLIC }, 'serif'],
    ['Times-BoldItalic', { baseName: 'Times-BoldItalic', flags: NONSYMBOLIC }, 'serif'],
    ['Helvetica', { baseName: 'Helvetica', flags: NONSYMBOLIC }, 'sans'],
    ['Courier-Bold', { baseName: 'Courier-Bold', flags: NONSYMBOLIC }, 'mono'],
    // PostScript names as producers write them.
    ['TimesNewRomanPSMT', { baseName: 'ABCDEF+TimesNewRomanPSMT', flags: SYMBOLIC }, 'serif'],
    ['Georgia-Italic', { baseName: 'Georgia-Italic', flags: ITALIC }, 'serif'],
    ['LiberationSerif', { baseName: 'AAAAAA+LiberationSerif', flags: SYMBOLIC }, 'serif'],
    ['CMR10 (TeX roman)', { baseName: 'XYZABC+CMR10', flags: SYMBOLIC }, 'serif'],
    ['CMBX12 (TeX bold)', { baseName: 'XYZABC+CMBX12', flags: SYMBOLIC }, 'serif'],
    ['CMSS10 (TeX sans)', { baseName: 'XYZABC+CMSS10', flags: SYMBOLIC }, 'sans'],
    ['CMTT10 (TeX typewriter)', { baseName: 'XYZABC+CMTT10', flags: SYMBOLIC }, 'mono'],
    ['NimbusRomNo9L', { baseName: 'NimbusRomNo9L-Regu', flags: SYMBOLIC }, 'serif'],
    ['Consolas', { baseName: 'ABCDEF+Consolas', flags: SYMBOLIC }, 'mono'],
    ['DejaVuSansMono', { baseName: 'DejaVuSansMono', flags: SYMBOLIC }, 'mono'],
    ['SourceCodePro', { baseName: 'SourceCodePro-Regular', flags: SYMBOLIC }, 'mono'],
    ['Arial-BoldMT', { baseName: 'ABCDEF+Arial-BoldMT', flags: NONSYMBOLIC }, 'sans'],
    ['Calibri', { baseName: 'ABCDEF+Calibri', flags: SYMBOLIC }, 'sans'],
    // "Sans" in the name wins over a wrongly set Serif flag.
    ['NotoSans with the Serif flag', { baseName: 'NotoSans-Regular', flags: SERIF }, 'sans'],
    ['PT Sans family name', { baseName: 'F4', familyName: 'PT Sans', flags: SERIF }, 'sans'],
    // ...but not over monospacing.
    ['Noto Sans Mono', { baseName: 'NotoSansMono-Regular', flags: 0 }, 'mono'],
    // PANOSE, when the program has it.
    ['PANOSE cove serif', { baseName: 'F5', flags: SYMBOLIC, panose: panose(2) }, 'serif'],
    ['PANOSE normal sans', { baseName: 'F6', flags: SERIF, panose: panose(11) }, 'sans'],
    ['PANOSE rounded sans', { baseName: 'F7', flags: 0, panose: panose(15) }, 'sans'],
    ['PANOSE monospaced', { baseName: 'F8', flags: 0, panose: panose(11, 9) }, 'mono'],
    // PANOSE "any" (0) or a non-text family says nothing: the flags decide.
    ['PANOSE any + Serif flag', { baseName: 'F9', flags: SERIF, panose: panose(0) }, 'serif'],
    [
      'PANOSE script family + Serif flag',
      { baseName: 'F10', flags: SERIF, panose: [3, 11, 5, 3, 0, 0, 0, 0, 0, 0] },
      'serif',
    ],
  ];
  test.each(cases)('%s', (_name, facts, expected) => {
    expect(substituteClass(facts)).toBe(expected);
  });
});

describe('substituteCandidates', () => {
  const keys = (cls: 'serif' | 'mono' | 'sans', bold: boolean) =>
    substituteCandidates(cls, bold).map((f) => f.key);

  test('sans tries Noto Sans, then Inter, then the other faces', () => {
    expect(keys('sans', false)).toEqual([
      'NotoSans-Regular',
      'Inter-Regular',
      'Inter-Bold',
      'JetBrainsMono-Regular',
      'NotoSerif-Regular',
      'NotoSerif-Bold',
    ]);
  });

  test('bold sans tries Inter Bold first: Noto Sans is bundled in regular only', () => {
    expect(keys('sans', true).slice(0, 3)).toEqual([
      'Inter-Bold',
      'NotoSans-Regular',
      'Inter-Regular',
    ]);
  });

  test('serif tries Noto Serif of the weight first', () => {
    expect(keys('serif', false).slice(0, 2)).toEqual(['NotoSerif-Regular', 'NotoSerif-Bold']);
    expect(keys('serif', true).slice(0, 3)).toEqual([
      'NotoSerif-Bold',
      'NotoSerif-Regular',
      'Inter-Bold',
    ]);
  });

  test('monospaced tries JetBrains Mono first, in either weight', () => {
    expect(keys('mono', false)[0]).toBe('JetBrainsMono-Regular');
    expect(keys('mono', true)[0]).toBe('JetBrainsMono-Regular');
  });

  test('every candidate list holds every face once', () => {
    for (const cls of ['serif', 'mono', 'sans'] as const) {
      for (const bold of [false, true]) {
        expect([...keys(cls, bold)].sort()).toEqual(BUNDLED_FACES.map((f) => f.key).sort());
      }
    }
  });

  test('without Noto Sans (a bundle that lacks it) sans falls back to Inter', () => {
    const faces = BUNDLED_FACES.filter((f) => f.family !== 'noto-sans');
    expect(substituteCandidates('sans', false, faces)[0]?.key).toBe('Inter-Regular');
  });

  test('a copy of a bundled family tries that family first', () => {
    expect(bundledFamilyOfFont('FXTAAA+Inter-Regular')).toBe('inter');
    expect(bundledFamilyOfFont('NotoSerif-BoldItalic')).toBe('noto-serif');
    expect(bundledFamilyOfFont('ABCDEF+JetBrainsMono-Regular')).toBe('jetbrains-mono');
    expect(bundledFamilyOfFont('NotoSans')).toBe('noto-sans');
    expect(bundledFamilyOfFont('InterDisplay-Regular')).toBeUndefined();
    expect(bundledFamilyOfFont('Helvetica')).toBeUndefined();
    const inter = substituteCandidates('sans', false, undefined, 'inter').map((f) => f.key);
    expect(inter.slice(0, 3)).toEqual(['Inter-Regular', 'NotoSans-Regular', 'Inter-Bold']);
  });

  test('family names', () => {
    expect(faceFamilyName('NotoSans-Regular')).toBe('Noto Sans');
    expect(faceFamilyName('NotoSerif-Bold')).toBe('Noto Serif');
    expect(faceFamilyName('JetBrainsMono-Regular')).toBe('JetBrains Mono');
    expect(faceFamilyName('Inter-Bold')).toBe('Inter');
    expect(faceFamilyName('Unknown')).toBe('Unknown');
  });
});

describe('x-height scale', () => {
  test('standard-14 fonts use their AFM metrics', () => {
    expect(standardFontMetrics('Helvetica')).toEqual({ xHeight: 0.523, capHeight: 0.718 });
    expect(standardFontMetrics('Times-Roman')).toEqual({ xHeight: 0.448, capHeight: 0.662 });
    expect(standardFontMetrics('Courier-Bold')?.xHeight).toBe(0.439);
    expect(standardFontMetrics('Helvetica,Bold')?.xHeight).toBe(0.523);
    expect(standardFontMetrics('ABCDEF+Arial')).toBeUndefined();
  });

  const noto = { xHeight: 0.536, capHeight: 0.714 };

  test('the x-heights are matched', () => {
    expect(substituteScale({ xHeight: 0.536 }, noto)).toBeCloseTo(1, 6);
    // Times in Noto Serif: 0.448 / 0.536.
    expect(substituteScale({ xHeight: 0.448 }, noto)).toBeCloseTo(0.8358, 3);
    // Helvetica in Noto Sans: 0.523 / 0.536.
    expect(substituteScale({ xHeight: 0.523, capHeight: 0.718 }, noto)).toBeCloseTo(0.9757, 3);
  });

  test('without an x-height the cap heights are matched; without either, 1', () => {
    expect(substituteScale({ capHeight: 0.66 }, noto)).toBeCloseTo(0.66 / 0.714, 6);
    expect(substituteScale({}, noto)).toBe(1);
    expect(substituteScale({ xHeight: 0 }, noto)).toBe(1);
  });

  test('a bad measurement is clamped', () => {
    expect(substituteScale({ xHeight: 0.1 }, noto)).toBe(SUBSTITUTE_SCALE_MIN);
    expect(substituteScale({ xHeight: 2 }, noto)).toBe(SUBSTITUTE_SCALE_MAX);
  });
});

describe('the bundled files', () => {
  test('x-heights and PANOSE in the catalog match the files', async () => {
    for (const face of BUNDLED_FACES) {
      const bytes = new Uint8Array(await (await fetch(bundledFontUrl(face))).arrayBuffer());
      const font = fontkit.create(bytes) as unknown as { xHeight: number; unitsPerEm: number };
      expect(face.xHeight, face.key).toBeCloseTo(font.xHeight / font.unitsPerEm, 3);
      const classOf = panoseOfProgram(bytes);
      if (face.family === 'noto-serif') expect(classOf?.[1]).toBe(2);
      if (face.family === 'noto-sans') expect(classOf?.[1]).toBe(11);
      if (face.family === 'jetbrains-mono') expect(classOf?.[3]).toBe(9);
    }
  });

  test('a program that is not TrueType or OpenType has no PANOSE', () => {
    expect(panoseOfProgram(new Uint8Array([1, 0, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
    expect(panoseOfProgram(new Uint8Array(4))).toBeUndefined();
  });

  test('Noto Sans covers what Inter lacks in Greek Extended, IPA and Latin Extended', async () => {
    const load = async (key: string) => {
      const face = BUNDLED_FACES.find((f) => f.key === key);
      if (!face) throw new Error(key);
      const bytes = new Uint8Array(await (await fetch(bundledFontUrl(face))).arrayBuffer());
      return fontkit.create(bytes) as unknown as { hasGlyphForCodePoint(cp: number): boolean };
    };
    const sans = await load('NotoSans-Regular');
    const inter = await load('Inter-Regular');
    for (const ch of ['ἀ', 'ɐ', 'ʃ', 'Ɐ', 'ꜧ', 'ğ', 'ş', 'İ', 'Ж', 'λ']) {
      expect(sans.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0), ch).toBe(true);
    }
    expect(inter.hasGlyphForCodePoint('ἀ'.codePointAt(0) ?? 0)).toBe(false);
    // Arrows: Inter has them, Noto Sans (Latin, Greek, Cyrillic) does not.
    expect(sans.hasGlyphForCodePoint(0x2192)).toBe(false);
    expect(inter.hasGlyphForCodePoint(0x2192)).toBe(true);
  });
});
