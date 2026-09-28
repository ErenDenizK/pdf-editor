/**
 * The revisions after a signed one, read the way a reader resolves objects (ISO 32000-2
 * §7.5.4–§7.5.8, spec §3.1 step 6, M5 review finding 1): through the cross-reference chain
 * walked back from the file's last `startxref`, never through the object definitions a text
 * scan (or pdf-lib, which ignores the xref) happens to see last.
 *
 * Rules, each one closing a way to show other content under an "Intact" signature:
 * - the chain from the end of the file must lead back to the signed revision's own section,
 *   through sections that all lie after the signed bytes, newest last in the file;
 * - every byte after the signed end belongs to a parsed part of some later revision: an
 *   object its xref points at, its xref section and trailer, or whitespace and comments
 *   (`%%EOF` is a comment). Anything else — a second definition of an object, a stray
 *   object, garbage — is a structural change;
 * - each in-use entry is resolved at its offset: the object header there must carry the
 *   entry's number and generation and the object must lie inside that revision;
 * - a compressed (type 2) entry resolves through an object stream that a later revision
 *   writes, and the stream's index must name the same object;
 * - a free (type 0) entry for an object that existed when signed deletes it (a reference to
 *   it reads as null);
 * - the trailer's /Root, /Info and /Encrypt are compared with the signed revision's.
 *
 * The resolved objects are parsed with pdf-lib's object parser into the context of a second
 * copy of the signed revision, which then shows the file as a reader does. Objects of an
 * encrypted file are parsed without decryption (pdf-lib does not expose its cipher), so
 * their strings and streams compare as changed: the error is always towards "changed".
 */
import {
  decodePDFRawStream,
  PDFName,
  PDFNumber,
  type PDFContext,
  type PDFObject,
  PDFObjectParser,
  PDFRawStream,
} from '@cantoo/pdf-lib';

import { type XrefEntry, type XrefSection, dictRef, lastStartxref, parseSection } from './xref';

/** One object as the later revisions leave it (the newest entry for its number). */
export interface LaterObject {
  readonly num: number;
  /** The entry's generation (-1 for a free entry). */
  readonly gen: number;
  /** 1-based revision (file order) whose xref gives this entry. */
  readonly revision: number;
  /** `undefined` for a free entry. */
  readonly object?: PDFObject;
}

/** Something about the later bytes no reader-visible object explains: kind `other`. */
export interface StructuralChange {
  readonly revision: number;
  readonly detail: string;
  /** Objects involved, e.g. `6 0 R`. */
  readonly objects: readonly string[];
}

export interface LaterRevisions {
  /** 1-based number of the newest revision (the signed one when there is no later one). */
  readonly lastRevision: number;
  /** The chain and every later section were read (else only `structural` says why not). */
  readonly complete: boolean;
  /** Newest entry per object number (a section's own xref stream is left out). */
  readonly objects: ReadonlyMap<number, LaterObject>;
  /** The newest trailer's references (raw), when it has them. */
  readonly root?: { num: number; gen: number };
  readonly info?: { num: number; gen: number };
  readonly encrypt?: { num: number; gen: number };
  readonly structural: readonly StructuralChange[];
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** Past whitespace and comments (a comment runs to the end of its line). */
function skipSpace(text: string, pos: number, end = text.length): number {
  let p = pos;
  while (p < end) {
    const c = text.charCodeAt(p);
    if (WS.has(c)) p++;
    else if (c === 0x25) {
      while (p < end && text[p] !== '\n' && text[p] !== '\r') p++;
    } else break;
  }
  return p;
}

interface Parsed {
  readonly num: number;
  readonly gen: number;
  readonly object: PDFObject;
  /** Just past `endobj`. */
  readonly end: number;
}

/**
 * The indirect object whose header is exactly at `offset`, parsed within `[offset, limit)`.
 * Throws when there is no `n g obj … endobj` there.
 */
function parseObjectAt(
  bytes: Uint8Array,
  text: string,
  offset: number,
  limit: number,
  context: PDFContext,
): Parsed {
  const header = /(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj/y;
  header.lastIndex = offset;
  const m = header.exec(text);
  if (!m || header.lastIndex > limit) throw new Error(`no object header at byte ${offset}`);
  const bodyAt = header.lastIndex;
  const parser = PDFObjectParser.forBytes(bytes.subarray(bodyAt, limit), context);
  const object = parser.parseObject();
  // The parser's position (protected in the typings): where the object ends.
  const consumed = (parser as unknown as { bytes: { offset(): number } }).bytes.offset();
  const after = skipSpace(text, bodyAt + consumed, limit);
  if (!text.startsWith('endobj', after) || after + 6 > limit) {
    throw new Error(`object ${m[1]} ${m[2]} at byte ${offset} has no endobj`);
  }
  return { num: Number(m[1]), gen: Number(m[2]), object, end: after + 6 };
}

interface RevisionPart {
  /** 1-based revision number. */
  readonly revision: number;
  readonly main: XrefSection;
  readonly stm?: XrefSection;
}

const ref = (num: number, gen: number) => `${num} ${gen} R`;

/**
 * Reads every revision after the one that ends at `signedEnd` (numbered from
 * `signedRevision + 1`), resolving objects into `context` (a fresh load of the signed bytes).
 */
export async function readLaterRevisions(
  bytes: Uint8Array,
  text: string,
  signedEnd: number,
  signedRevision: number,
  context: PDFContext,
): Promise<LaterRevisions> {
  const structural: StructuralChange[] = [];
  const objects = new Map<number, LaterObject>();
  const signedStartxref = lastStartxref(bytes, signedEnd);
  const firstLater = signedRevision + 1;
  const whole = (detail: string): LaterRevisions => ({
    lastRevision: firstLater,
    complete: false,
    objects,
    structural: [...structural, { revision: firstLater, detail, objects: [] }],
  });
  if (signedStartxref === undefined) {
    return whole('The signed revision has no startxref, so what follows it cannot be read.');
  }

  // 1. The chain from the end of the file back to the signed revision's section.
  const chain: { main: XrefSection; stm?: XrefSection }[] = [];
  let offset = lastStartxref(bytes);
  const seen = new Set<number>();
  while (offset !== signedStartxref) {
    if (offset === undefined) {
      return whole('The cross-reference chain ends before it reaches the signed revision.');
    }
    if (offset < signedEnd || seen.has(offset) || chain.length > 4096) {
      return whole(
        `The cross-reference chain leads to byte ${offset}, not back to the signed revision's section at ${signedStartxref}.`,
      );
    }
    seen.add(offset);
    let main: XrefSection;
    let stm: XrefSection | undefined;
    try {
      main = await parseSection(bytes, offset);
      if (main.xrefStm !== undefined) {
        if (main.xrefStm < signedEnd)
          throw new Error(`/XRefStm ${main.xrefStm} is in the signed bytes`);
        stm = await parseSection(bytes, main.xrefStm);
      }
    } catch (error) {
      return whole(
        `The cross-reference section at byte ${offset} cannot be read (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    const previous = chain[chain.length - 1];
    if (previous && offset >= previous.main.offset) {
      return whole('The later cross-reference sections are not in file order.');
    }
    chain.push(stm ? { main, stm } : { main });
    offset = main.prev;
  }
  if (chain.length === 0) {
    // The file's last startxref is the signed one, yet bytes follow the signed range.
    return whole('Bytes follow the signed revision, but no cross-reference section covers them.');
  }
  const parts: RevisionPart[] = chain
    .reverse()
    .map((c, i) => ({ revision: firstLater + i, main: c.main, ...(c.stm ? { stm: c.stm } : {}) }));

  // 2. Each revision's bytes: objects at their offsets, the section, the trailer.
  const parsedAt = new Map<number, Parsed>();
  const newest = new Map<number, { entry: XrefEntry; revision: number }>();
  let start = signedEnd;
  for (const part of parts) {
    const { revision, main, stm } = part;
    const covered: [number, number][] = [];
    let xrefEnd: number;
    try {
      xrefEnd = sectionEnd(bytes, text, main, context);
    } catch (error) {
      structural.push({
        revision,
        detail: `The trailer of revision ${revision} cannot be read (${error instanceof Error ? error.message : String(error)}).`,
        objects: [],
      });
      return {
        lastRevision: parts[parts.length - 1]?.revision ?? firstLater,
        complete: false,
        objects,
        structural,
      };
    }
    covered.push([main.offset, xrefEnd]);
    const entries = [...(stm?.entries ?? []), ...main.entries];
    const selfObjects = new Set(
      [main.streamObject, stm?.streamObject].filter((n): n is number => n !== undefined),
    );
    if (stm) {
      try {
        const parsed = parseObjectAt(bytes, text, stm.offset, main.offset, context);
        covered.push([stm.offset, parsed.end]);
      } catch (error) {
        structural.push({
          revision,
          detail: `The /XRefStm stream of revision ${revision} cannot be read (${error instanceof Error ? error.message : String(error)}).`,
          objects: [],
        });
      }
    }
    for (const entry of entries) {
      if (entry.num === 0) continue;
      if (entry.type === 1 && !selfObjects.has(entry.num)) {
        const at = entry.field2;
        if (at < start || at >= main.offset) {
          structural.push({
            revision,
            detail: `Revision ${revision} points object ${ref(entry.num, entry.field3)} at byte ${at}, outside its own bytes (${start}–${main.offset}).`,
            objects: [ref(entry.num, entry.field3)],
          });
          newest.delete(entry.num);
          continue;
        }
        try {
          const parsed = parsedAt.get(at) ?? parseObjectAt(bytes, text, at, main.offset, context);
          parsedAt.set(at, parsed);
          if (parsed.num !== entry.num || parsed.gen !== entry.field3) {
            throw new Error(
              `the object at byte ${at} is ${ref(parsed.num, parsed.gen)}, not ${ref(entry.num, entry.field3)}`,
            );
          }
          covered.push([at, parsed.end]);
        } catch (error) {
          structural.push({
            revision,
            detail: `Object ${ref(entry.num, entry.field3)} of revision ${revision} cannot be resolved (${error instanceof Error ? error.message : String(error)}).`,
            objects: [ref(entry.num, entry.field3)],
          });
          newest.delete(entry.num);
          continue;
        }
      }
      if (selfObjects.has(entry.num)) continue;
      newest.set(entry.num, { entry, revision });
    }
    // Every byte of the revision is accounted for.
    covered.sort((a, b) => a[0] - b[0]);
    let pos = start;
    for (const [from, to] of [...covered, [xrefEnd, xrefEnd] as [number, number]]) {
      const gapEnd = Math.min(from, xrefEnd);
      if (gapEnd > pos && skipSpace(text, pos, gapEnd) < gapEnd) {
        const junk = skipSpace(text, pos, gapEnd);
        const stray = [...text.slice(junk, gapEnd).matchAll(/(?<!\d)(\d+)\s+(\d+)\s+obj\b/g)].map(
          (h) => ref(Number(h[1]), Number(h[2])),
        );
        structural.push({
          revision,
          detail:
            stray.length > 0
              ? `Revision ${revision} writes ${stray.join(', ')} at byte ${junk} without listing it in its cross-reference section (a reader ignores it, other tools may not).`
              : `Bytes ${junk}–${gapEnd} of revision ${revision} belong to no object, section or trailer.`,
          objects: stray,
        });
      }
      pos = Math.max(pos, to);
    }
    start = xrefEnd;
  }
  // Nothing but whitespace and comments after the last trailer.
  if (skipSpace(text, start) < text.length) {
    structural.push({
      revision: parts[parts.length - 1]?.revision ?? firstLater,
      detail: `Bytes from ${skipSpace(text, start)} to the end of the file follow the last trailer.`,
      objects: [],
    });
  }

  // 3. Resolve the newest entry of every object number.
  const streams = new Map<
    number,
    { data: Uint8Array; offsets: [number, number][]; first: number } | Error
  >();
  const objectStream = (num: number) => {
    let found = streams.get(num);
    if (found) return found;
    try {
      const holder = newest.get(num);
      if (holder?.entry.type !== 1) {
        throw new Error(`object stream ${num} is not written after signing`);
      }
      const stream = parsedAt.get(holder.entry.field2)?.object;
      if (!(stream instanceof PDFRawStream)) throw new Error(`object ${num} is not a stream`);
      if (stream.dict.get(PDFName.of('Type')) !== PDFName.of('ObjStm')) {
        throw new Error(`object ${num} is not an object stream`);
      }
      const n = stream.dict.get(PDFName.of('N'));
      const first = stream.dict.get(PDFName.of('First'));
      if (!(n instanceof PDFNumber) || !(first instanceof PDFNumber)) {
        throw new Error(`object stream ${num} has no direct /N and /First`);
      }
      const data = decodePDFRawStream(stream).decode();
      const head = new TextDecoder('latin1')
        .decode(data.subarray(0, first.asNumber()))
        .trim()
        .split(/\s+/)
        .map(Number);
      const offsets: [number, number][] = [];
      for (let i = 0; i < n.asNumber(); i++)
        offsets.push([head[2 * i] ?? -1, head[2 * i + 1] ?? -1]);
      found = { data, offsets, first: first.asNumber() };
    } catch (error) {
      found = error instanceof Error ? error : new Error(String(error));
    }
    streams.set(num, found);
    return found;
  };
  for (const [num, { entry, revision }] of newest) {
    if (entry.type === 0) {
      objects.set(num, { num, gen: -1, revision });
      continue;
    }
    if (entry.type === 1) {
      const parsed = parsedAt.get(entry.field2);
      if (!parsed) continue;
      objects.set(num, { num, gen: entry.field3, revision, object: parsed.object });
      continue;
    }
    // Type 2: object `num` at index field3 of object stream field2.
    const stream = objectStream(entry.field2);
    try {
      if (stream instanceof Error) throw stream;
      const [inStream, at] = stream.offsets[entry.field3] ?? [-1, -1];
      if (inStream !== num) {
        throw new Error(
          `index ${entry.field3} of object stream ${entry.field2} holds object ${inStream}`,
        );
      }
      const object = PDFObjectParser.forBytes(
        stream.data.subarray(stream.first + at),
        context,
      ).parseObject();
      objects.set(num, { num, gen: 0, revision, object });
    } catch (error) {
      structural.push({
        revision,
        detail: `Compressed object ${ref(num, 0)} of revision ${revision} cannot be resolved (${error instanceof Error ? error.message : String(error)}).`,
        objects: [ref(num, 0)],
      });
    }
  }

  const last = parts[parts.length - 1] as RevisionPart;
  const dict = last.main.dict;
  const root = dictRef(dict, 'Root');
  const info = dictRef(dict, 'Info');
  const encrypt = dictRef(dict, 'Encrypt');
  return {
    lastRevision: last.revision,
    complete: true,
    objects,
    ...(root ? { root } : {}),
    ...(info ? { info } : {}),
    ...(encrypt ? { encrypt } : {}),
    structural,
  };
}

/**
 * Where a section and its trailer end: past the digits of the `startxref` that follows
 * (a `%%EOF` after it is a comment). The value must point back at the section.
 */
function sectionEnd(
  bytes: Uint8Array,
  text: string,
  section: XrefSection,
  context: PDFContext,
): number {
  let pos: number;
  if (section.kind === 'table') {
    const trailer = text.indexOf('trailer', section.offset);
    if (trailer < 0) throw new Error('no trailer');
    const dictAt = skipSpace(text, trailer + 7);
    if (!text.startsWith('<<', dictAt)) throw new Error('the trailer is not a dictionary');
    const parser = PDFObjectParser.forBytes(bytes.subarray(dictAt), context);
    parser.parseObject();
    pos = dictAt + (parser as unknown as { bytes: { offset(): number } }).bytes.offset();
  } else {
    pos = parseObjectAt(bytes, text, section.offset, text.length, context).end;
  }
  const at = skipSpace(text, pos);
  const m = /startxref[\0\t\n\f\r ]+(\d+)/y;
  m.lastIndex = at;
  const found = m.exec(text);
  if (!found) throw new Error(`no startxref after the section at byte ${section.offset}`);
  if (Number(found[1]) !== section.offset) {
    throw new Error(`its startxref says ${found[1]}, not ${section.offset}`);
  }
  return m.lastIndex;
}
