/**
 * Human font names for the text editor's header. A PDF names its fonts by PostScript name
 * (`ABCDEF+TimesNewRomanPSMT`, `Arial-BoldMT`), which reads as an identifier; the header shows
 * "Times New Roman" and "Arial Bold" instead, with the raw name kept in a tooltip.
 */

/** Tokens that belong to the PostScript name, not to the family: dropped after the first word. */
const SUFFIX_TOKENS: ReadonlySet<string> = new Set(['PSMT', 'PS', 'MT', 'Identity', 'H']);

/** Style words, in the form they are shown in, keyed in lower case. */
const STYLE_TOKENS: Readonly<Record<string, string>> = {
  bold: 'Bold',
  italic: 'Italic',
  regular: 'Regular',
  oblique: 'Oblique',
};

/** Splits a camel-cased word: `TimesNewRoman` → Times New Roman, `Code128` → Code 128. */
function splitCamel(token: string): string[] {
  return (
    token
      // lower → upper: `NewRoman` → `New Roman`
      .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
      // an acronym before a word: `MSGothic` → `MS Gothic`
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
      // letter → digit: `Code128` → `Code 128`
      .replace(/(\p{L})(\p{Nd})/gu, '$1 $2')
      .split(' ')
      .filter((word) => word !== '')
  );
}

/**
 * `TimesNewRomanPSMT` → "Times New Roman", `ABCDEF+Inter-Regular` → "Inter Regular",
 * `Arial-BoldMT` → "Arial Bold", `NotoSerif-Bold` → "Noto Serif Bold".
 *
 * Strips the subset tag, splits on `-`, `,` and `_` and at camel-case and letter-digit
 * boundaries, drops the PostScript suffixes (PSMT, PS, MT, Identity, H) and moves the style
 * words (Bold, Italic, Regular, Oblique) to the end. A name that would come out empty is
 * returned without its subset tag, as it was.
 */
export function humanFontName(psName: string): string {
  const bare = psName.replace(/^[A-Z]{6}\+/, '').trim();
  if (bare === '') return '?';
  const words = bare.split(/[-,_\s]+/).flatMap(splitCamel);
  const family: string[] = [];
  const style: string[] = [];
  words.forEach((word, i) => {
    const styleWord = STYLE_TOKENS[word.toLowerCase()];
    if (styleWord !== undefined && i > 0) style.push(styleWord);
    else if (i === 0 || !SUFFIX_TOKENS.has(word)) family.push(word);
  });
  if (family.length === 0) return bare;
  return [...family, ...style].join(' ');
}
