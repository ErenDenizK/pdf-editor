/**
 * Copy check (docs/specs/presentation.md §1.3 and §8 "Links"): the public copy must not use
 * the banned words, exclamation marks or emoji. Checks README.md, the about page
 * (`apps/web/about/**\/*.html`) and the release-notes template (`.github/release-notes.md`);
 * a default input that does not exist yet is skipped. Prints `file:line:column: problem` for
 * every hit and exits 1 when there is one.
 *
 *   node --experimental-strip-types tools/copy-check/check.ts [file or folder …]
 *
 * Only words a reader sees are checked: fenced code blocks (Mermaid diagrams excepted),
 * inline code, HTML comments, URLs, tags, scripts and styles are blanked first, keeping the
 * reader-facing attributes `alt`, `title`, `aria-label`, `content` and `placeholder`.
 * Matching is case-insensitive and on whole words, so "justify" and "insecure" pass.
 * "secure" passes only before a noun from SECURE_NOUNS, where it names a technical term
 * ("secure context") rather than making a claim.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

/** Checked when no arguments are given, relative to the repository root. */
const DEFAULT_INPUTS = ['README.md', 'apps/web/about', '.github/release-notes.md'];

/** Spec §1.3, with the obvious inflections. Hyphenated entries match as written. */
const BANNED_WORDS = [
  'powerful',
  'blazing',
  'blazingly',
  'lightning',
  'seamless',
  'seamlessly',
  'effortless',
  'effortlessly',
  'simply',
  'just',
  'magic',
  'magical',
  'magically',
  'best-in-class',
  'enterprise-grade',
  'military-grade',
  'revolutionary',
] as const;

/** Spec §1.3 phrases; any whitespace between the words, including a line break. */
const BANNED_PHRASES = ['the only', "we're excited", 'we’re excited', 'we are excited'] as const;

/** Nouns after which "secure" is a term of art, not a claim. Lower case. */
const SECURE_NOUNS = new Set(['context', 'contexts', 'origin', 'origins', 'hash', 'hashes']);

/** Attributes whose values a reader sees (or a link preview shows). */
const VISIBLE_ATTRIBUTES =
  /\b(?:alt|title|aria-label|content|placeholder)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;

/** Emoji drawn as pictures: presentation-default emoji, or any pictograph forced by U+FE0F. */
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/gu;

const WORD_CHAR = String.raw`[\p{L}\p{N}_-]`;

interface Problem {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function wholeWord(source: string): RegExp {
  return new RegExp(`(?<!${WORD_CHAR})${source}(?!${WORD_CHAR})`, 'giu');
}

/** Spaces for every character except line breaks, so offsets and line numbers survive. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/** A tag blanked except for the values of its reader-facing attributes. */
function blankTag(tag: string): string {
  let kept = blank(tag);
  for (const match of tag.matchAll(VISIBLE_ATTRIBUTES)) {
    const value = match[1] ?? match[2] ?? '';
    // The value ends just before the closing quote; offsets are UTF-16 code units throughout.
    const start = match.index + match[0].length - value.length - 1;
    kept = kept.slice(0, start) + value + kept.slice(start + value.length);
  }
  return kept;
}

function blankHtml(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, blank)
    .replace(/<[^>]*>/g, blankTag);
}

/** Blanks fenced code blocks, keeping the contents of Mermaid blocks (their labels are copy). */
function blankFences(text: string): string {
  let fence: { readonly marker: string; readonly keep: boolean } | undefined;
  return text
    .split('\n')
    .map((line) => {
      const opening = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
      if (fence === undefined) {
        if (!opening) return line;
        fence = { marker: opening[1] ?? '```', keep: opening[2] === 'mermaid' };
        return blank(line);
      }
      const closing = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closing && (closing[1] ?? '').startsWith(fence.marker)) {
        fence = undefined;
        return blank(line);
      }
      return fence.keep ? line : blank(line);
    })
    .join('\n');
}

function blankMarkdown(text: string): string {
  const withoutBlocks = blankFences(text.replace(/<!--[\s\S]*?-->/g, blank));
  return blankHtml(withoutBlocks.replace(/(`+)[^`]*?\1/g, blank))
    .replace(/\]\([^)]*\)/g, (target) => `]${blank(target.slice(1))}`)
    .replace(/\bhttps?:\/\/[^\s)\]>]+/g, blank)
    .replace(/!\[/g, ' [');
}

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

function checkText(file: string, original: string): Problem[] {
  const text = extname(file) === '.html' ? blankHtml(original) : blankMarkdown(original);
  const hits: { offset: number; message: string }[] = [];

  for (const word of BANNED_WORDS) {
    for (const match of text.matchAll(wholeWord(escapeRegExp(word)))) {
      hits.push({ offset: match.index, message: `banned word "${match[0]}"` });
    }
  }
  for (const phrase of BANNED_PHRASES) {
    const source = phrase.split(' ').map(escapeRegExp).join(String.raw`\s+`);
    for (const match of text.matchAll(wholeWord(source))) {
      hits.push({
        offset: match.index,
        message: `banned phrase "${match[0].replace(/\s+/g, ' ')}"`,
      });
    }
  }
  for (const match of text.matchAll(wholeWord('secure'))) {
    const next = /^\s+([\p{L}-]+)/u.exec(text.slice(match.index + match[0].length));
    if (next?.[1] && SECURE_NOUNS.has(next[1].toLowerCase())) continue;
    hits.push({
      offset: match.index,
      message: `"${match[0]}" on its own (allowed before: ${[...SECURE_NOUNS].join(', ')})`,
    });
  }
  for (const match of text.matchAll(/!/g)) {
    hits.push({ offset: match.index, message: 'exclamation mark' });
  }
  for (const match of text.matchAll(EMOJI)) {
    hits.push({ offset: match.index, message: `emoji "${match[0]}"` });
  }

  return hits
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, message }) => ({ file, ...position(text, offset), message }));
}

/** Markdown and HTML files under `path` (or `path` itself), sorted. */
function collect(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true, encoding: 'utf8' })
    .filter((name) => ['.md', '.html'].includes(extname(name)))
    .map((name) => join(path, name))
    .sort();
}

function main(args: readonly string[]): number {
  const explicit = args.length > 0;
  const inputs = explicit
    ? args.map((arg) => resolve(arg))
    : DEFAULT_INPUTS.map((input) => resolve(ROOT, input));
  const files: string[] = [];
  for (const input of inputs) {
    const shown = relative(ROOT, input);
    if (existsSync(input)) files.push(...collect(input));
    else if (explicit) {
      console.error(`${shown}: not found`);
      return 2;
    } else process.stdout.write(`${shown}: not there yet, skipped\n`);
  }

  const problems = files.flatMap((file) =>
    checkText(relative(ROOT, file), readFileSync(file, 'utf8')),
  );
  for (const problem of problems) {
    console.error(`${problem.file}:${problem.line}:${problem.column}: ${problem.message}`);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} problem(s) in the public copy (docs/specs/presentation.md §1.3).`,
    );
    return 1;
  }
  process.stdout.write(
    `Copy check passed: ${files.map((file) => relative(ROOT, file)).join(', ')}\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
