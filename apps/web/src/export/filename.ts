/**
 * Output file names. Derived from the document title; safe on Windows, macOS and Linux
 * (no reserved characters, no trailing dots or spaces, bounded length), always `.pdf`.
 */

const RESERVED = /[<>:"/\\|?*]/g;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_STEM = 120;

function withoutControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0x09 || code === 0x0a || code === 0x0d) out += ' ';
    else if (code >= 0x20 && code !== 0x7f) out += char;
  }
  return out;
}

/** A clean `.pdf` file name for `title`, or `document.pdf` when nothing usable is left. */
export function exportFileName(title: string): string {
  let stem = withoutControlCharacters(title)
    .replace(RESERVED, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.pdf$/i, '')
    .replace(/[. ]+$/, '');
  if (stem.length > MAX_STEM) stem = stem.slice(0, MAX_STEM).trim();
  if (stem === '' || WINDOWS_DEVICE.test(stem))
    stem = stem === '' ? 'document' : `${stem}-document`;
  return `${stem}.pdf`;
}
