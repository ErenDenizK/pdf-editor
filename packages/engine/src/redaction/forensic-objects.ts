/**
 * Forensic checks on the parsed object graph (research 06 §4 checks 2, 5 and 7):
 * reachability, a walk over every string, name and decodable stream of every object (the
 * shown text of content streams read with the lexer of `content-text.ts`; embedded files
 * that should have been removed), and annotations left in an area.
 */

import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
} from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

import {
  annotationSubtype,
  catalogNameTree,
  NAMES,
  nameTreeEntries,
  pageAnnotations,
} from '../pdflib/metadata-walk';
import type { ForensicFinding } from '../types';
import { grepBytes } from './byte-grep';
import { type ContentStreamKind, contentStreams, normalizedShownText } from './content-text';
import type { GrepTarget } from './forensic-file';
import {
  annotationInAreas,
  decodeStreamOutcome,
  embeddedFileStreams,
  isStructuralStream,
  otherEmbeddedFiles,
  reachableRefs,
  refKey,
  sortedObjects,
} from './pdf-util';
import type { RedactedStringMatcher } from './strings';

function describe(doc: PDFDocument, object: PDFObject): string {
  const dict = object instanceof PDFStream ? object.dict : object;
  if (!(dict instanceof PDFDict)) return object.constructor.name.replace(/^PDF/, '').toLowerCase();
  const parts = ['Type', 'Subtype', 'S']
    .map((k) => doc.context.lookup(dict.get(PDFName.of(k))))
    .filter((v): v is PDFName => v instanceof PDFName)
    .map((v) => v.toString());
  return parts.length > 0 ? parts.join(' ') : object instanceof PDFStream ? 'stream' : 'dictionary';
}

/**
 * Check 2: indirect objects not reachable from the trailer (file structure excluded).
 * `trailerRoots` are "num gen" keys named by the raw trailers (pdf-lib drops /Encrypt from
 * its trailer once it decrypted a file, so the encryption dictionary is passed this way).
 */
export function unreachableFindings(
  doc: PDFDocument,
  trailerRoots: ReadonlySet<string> = new Set(),
): ForensicFinding[] {
  const reachable = reachableRefs(doc.context);
  const findings: ForensicFinding[] = [];
  for (const [ref, object] of sortedObjects(doc.context)) {
    const key = refKey(ref);
    if (reachable.has(key) || trailerRoots.has(key) || isStructuralStream(doc.context, object)) {
      continue;
    }
    findings.push({
      where: `object ${ref.objectNumber} ${ref.generationNumber}`,
      objectNumber: ref.objectNumber,
      channel: 'unreachable',
      detail: describe(doc, object),
    });
  }
  return findings;
}

/** Check 5 output: hits and streams that could not be decoded. */
export interface StringWalkResult {
  readonly findings: ForensicFinding[];
  readonly notSearched: string[];
}

/** Options of check 5 beyond the strings. */
export interface StringWalkOptions {
  /**
   * Normalised redacted strings (`normalizeForMatch`) by plan index, looked for in the
   * shown text of content streams.
   */
  readonly needles?: readonly { readonly stringIndex: number; readonly needle: string }[];
  /** Attachments were kept; otherwise any embedded file stream left is a finding. */
  readonly keepAttachments?: boolean;
}

/**
 * Check 5: every string, name (keys included) and decodable stream of every object; the
 * shown text of every content stream (page contents, Form XObjects and appearances,
 * tiling patterns, Type3 glyph procedures); and, unless attachments were kept, every
 * embedded file stream still in the file.
 */
export function objectStringFindings(
  doc: PDFDocument,
  matcher: RedactedStringMatcher,
  targets: readonly GrepTarget[],
  options: StringWalkOptions = {},
): StringWalkResult {
  const findings: ForensicFinding[] = [];
  const notSearched: string[] = [];
  const needles = options.needles ?? [];
  const content: ReadonlyMap<PDFStream, ContentStreamKind> =
    needles.length > 0 ? contentStreams(doc) : new Map();
  const bytesHit = (bytes: Uint8Array) =>
    targets.flatMap((t) =>
      grepBytes(bytes, t.variants).map((h) => `${h.variant} (string ${t.stringIndex})`),
    );
  for (const [ref, object] of sortedObjects(doc.context)) {
    if (isStructuralStream(doc.context, object)) continue;
    const n = ref.objectNumber;
    const hit = (path: string, channel: string, detail?: string) =>
      findings.push({
        where: `object ${n}${path === '' ? '' : `, ${path}`}`,
        objectNumber: n,
        channel,
        ...(detail === undefined ? {} : { detail }),
      });
    const stack: { value: PDFObject; path: string; depth: number }[] = [
      { value: object, path: '', depth: 0 },
    ];
    const seen = new Set<PDFObject>();
    while (stack.length > 0) {
      const { value, path, depth } = stack.pop() as {
        value: PDFObject;
        path: string;
        depth: number;
      };
      if (value instanceof PDFRef || seen.has(value) || depth > 64) continue;
      if (value instanceof PDFString || value instanceof PDFHexString) {
        let text: string | undefined;
        try {
          text = value.decodeText();
        } catch {
          text = undefined;
        }
        if (text !== undefined && matcher.matches(text)) hit(path, 'string');
        else {
          const variants = bytesHit(value.asBytes());
          if (variants.length > 0) hit(path, 'string bytes', variants.join(', '));
        }
        continue;
      }
      if (value instanceof PDFName) {
        if (matcher.matches(value.decodeText())) hit(path, 'name');
        continue;
      }
      seen.add(value);
      if (value instanceof PDFStream) {
        const decoded = decodeStreamOutcome(doc.context, value);
        if ('data' in decoded) {
          const variants = bytesHit(decoded.data);
          if (variants.length > 0) {
            hit(`${path} (stream data)`.trim(), 'stream', variants.join(', '));
          } else {
            const kind = content.get(value);
            if (kind !== undefined) {
              const texts = normalizedShownText(decoded.data);
              const shown = needles.filter((t) => texts.some((x) => x.includes(t.needle)));
              if (shown.length > 0) {
                hit(
                  `${path} (shown text)`.trim(),
                  'content text',
                  `${kind}: ${shown.map((t) => `redacted string ${t.stringIndex}`).join(', ')}`,
                );
              }
            }
          }
        } else {
          notSearched.push(`object ${n} (${decoded.reason})`);
        }
        stack.push({ value: value.dict, path, depth: depth + 1 });
      } else if (value instanceof PDFDict) {
        const entries = value.entries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const [key, child] = entries[i] as [PDFName, PDFObject];
          const keyPath = `${path}/${key.decodeText()}`;
          if (matcher.matches(key.decodeText())) hit(keyPath, 'name (key)');
          stack.push({ value: child, path: keyPath, depth: depth + 1 });
        }
      } else if (value instanceof PDFArray) {
        for (let i = value.size() - 1; i >= 0; i--) {
          stack.push({ value: value.get(i), path: `${path}[${i}]`, depth: depth + 1 });
        }
      }
    }
  }
  if (options.keepAttachments !== true) {
    for (const { ref, name } of embeddedFileStreams(doc)) {
      findings.push({
        where: `object ${ref.objectNumber}`,
        objectNumber: ref.objectNumber,
        channel: 'embedded file',
        detail: `${name === undefined ? 'an embedded file' : `embedded file "${name}"`} is left although attachments were to be removed`,
      });
    }
  }
  return { findings, notSearched };
}

/** Check 7: annotations (widgets included) intersecting an area, and any /Redact left. */
export function annotationFindings(
  doc: PDFDocument,
  areasByPage: ReadonlyMap<number, readonly Rect[]>,
): ForensicFinding[] {
  const findings: ForensicFinding[] = [];
  for (const { pageIndex, annots } of pageAnnotations(doc)) {
    const areas = areasByPage.get(pageIndex) ?? [];
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      const annot = doc.context.lookupMaybe(entry, PDFDict);
      if (!annot) continue;
      const subtype = annotationSubtype(doc, annot) ?? 'unknown';
      const inArea = areas.length > 0 && annotationInAreas(doc.context, annot, areas);
      if (!inArea && subtype !== 'Redact') continue;
      const objectNumber = entry instanceof PDFRef ? entry.objectNumber : undefined;
      findings.push({
        where: `page ${pageIndex + 1}, /Annots[${i}]${objectNumber === undefined ? '' : ` (object ${objectNumber})`}`,
        pageIndex,
        ...(objectNumber === undefined ? {} : { objectNumber }),
        channel: 'annotation',
        detail: inArea ? `${subtype} intersects an area` : 'pending /Redact mark',
      });
    }
  }
  return findings;
}

/**
 * Names of embedded files and file attachment annotations in the output: the
 * /EmbeddedFiles tree, FileAttachment annotations, then every other embedded file stream.
 */
export function attachmentNames(doc: PDFDocument): string[] {
  const names: string[] = [];
  const tree = catalogNameTree(doc, NAMES.EmbeddedFiles);
  for (const [name] of tree ? nameTreeEntries(doc, tree) : []) names.push(name);
  for (const { pageIndex, annots } of pageAnnotations(doc)) {
    for (let i = 0; i < annots.size(); i++) {
      const annot = doc.context.lookupMaybe(annots.get(i), PDFDict);
      if (annot && annotationSubtype(doc, annot) === 'FileAttachment') {
        names.push(`file attachment annotation on page ${pageIndex + 1}`);
      }
    }
  }
  names.push(...otherEmbeddedFiles(doc));
  return names;
}
