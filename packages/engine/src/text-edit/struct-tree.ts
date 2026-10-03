/**
 * Paragraph tags of a tagged page (spec craft §4.1 step 1, research 11 §3.1): the structure
 * elements that stand for a paragraph (`/P`, `/LI`, `/LBody`, `/H1`–`/H6`, after the
 * /RoleMap) and the marked-content ids (MCIDs) they own, read through PDFium's structure
 * tree API. Valid only inside `HostedEngine.withRawAccess`.
 *
 * Malformed trees never throw: the walk stops at a depth and element budget, skips elements
 * it has already visited, and returns what it read before a call failed.
 */
import type { RawText } from './raw';

/** Structure types that form one paragraph each. */
export const PARAGRAPH_TYPES: ReadonlySet<string> = new Set([
  'P',
  'LI',
  'LBody',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
]);

/** Deepest element nesting walked. */
const MAX_DEPTH = 64;
/** Most elements visited on one page. */
const MAX_ELEMENTS = 20_000;

export interface ParagraphTag {
  /** The structure type, role-mapped (`P`, `LI`, `LBody`, `H1`…`H6`). */
  readonly type: string;
  /**
   * MCIDs on this page the element owns, in tree order: its own marked content and that of
   * descendants which are not paragraph elements themselves (spans, links…). A nested
   * paragraph element (an `LBody` inside an `LI`) is its own tag and keeps its MCIDs. Marked
   * content in a Form XObject stream (an MCR with /Stm) counts too, in that stream's numbering.
   */
  readonly mcids: readonly number[];
  /** Index in the result of the nearest enclosing paragraph tag (`LI` around `LBody`). */
  readonly parent?: number;
  /** /ActualText of the element, when present. */
  readonly actualText?: string;
  /** /Lang of the element, when present. */
  readonly lang?: string;
}

/** The paragraph tags of the page, in tree order (pre-order); `[]` for an untagged page. */
export function readParagraphTags(raw: RawText, pagePtr: number): ParagraphTag[] {
  const out: OpenTag[] = [];
  try {
    raw.withStructTree(pagePtr, (tree) => {
      if (!tree) return;
      new TagWalker(raw, out).walk(raw.structTreeChildren(tree));
    });
  } catch {
    // A failing PDFium call on a malformed tree: keep what was read.
  }
  return out;
}

/** A tag being filled while its subtree is walked. */
interface OpenTag {
  readonly type: string;
  readonly mcids: number[];
  readonly parent?: number;
  readonly actualText?: string;
  readonly lang?: string;
}

class TagWalker {
  private readonly seen = new Set<number>();

  constructor(
    private readonly raw: RawText,
    private readonly out: OpenTag[],
  ) {}

  walk(roots: readonly number[]): void {
    for (const root of roots) this.visit(root, 0, undefined);
  }

  /** `owner`: the index in `out` of the paragraph tag collecting MCIDs here. */
  private visit(element: number, depth: number, owner: number | undefined): void {
    if (depth > MAX_DEPTH || this.seen.size >= MAX_ELEMENTS || this.seen.has(element)) return;
    this.seen.add(element);
    const { raw } = this;
    const type = raw.structElementType(element);
    let collector = owner;
    if (PARAGRAPH_TYPES.has(type)) {
      const actualText = raw.structElementActualText(element);
      const lang = raw.structElementLang(element);
      const tag: OpenTag = {
        type,
        mcids: [],
        ...(owner !== undefined ? { parent: owner } : {}),
        ...(actualText ? { actualText } : {}),
        ...(lang ? { lang } : {}),
      };
      collector = this.out.length;
      this.out.push(tag);
    }
    const tag = collector !== undefined ? this.out[collector] : undefined;
    for (const kid of raw.structElementKids(element)) {
      if ('element' in kid) this.visit(kid.element, depth + 1, collector);
      else tag?.mcids.push(kid.mcid);
    }
  }
}
