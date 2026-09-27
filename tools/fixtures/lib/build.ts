/** Document-building helpers shared by the fixture builders (generate.ts, m4-fixtures.ts). */
import {
  PDFDocument,
  type PDFFont,
  PDFHexString,
  PDFName,
  type PDFPage,
  PDFString,
  PageSizes,
  rgb,
} from '@cantoo/pdf-lib';
import { CREATOR, type Expectations, FIXED_DATE, PRODUCER, fileIdFor } from './common.ts';

export const A4 = PageSizes.A4; // [595.28, 841.89]
export const LETTER = PageSizes.Letter; // [612, 792]

export interface Built {
  bytes: Uint8Array;
  expect: Expectations;
}

export interface FixtureDef {
  file: string;
  tags: string[];
  summary: string;
  behavior: string;
  howGenerated: string;
  passwords?: { user: string; owner: string };
  derivedFrom?: string;
  build: (built: Map<string, Uint8Array>) => Promise<Built>;
}

export async function newDoc(title: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(title);
  doc.setCreator(CREATOR);
  doc.setProducer(PRODUCER);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  return doc;
}

export interface SaveOpts {
  objectStreams?: boolean;
  updateFieldAppearances?: boolean;
}

export async function save(
  doc: PDFDocument,
  file: string,
  opts: SaveOpts = {},
): Promise<Uint8Array> {
  if (!doc.context.security) {
    const id = PDFHexString.fromBytes(fileIdFor(file));
    doc.context.trailerInfo.ID = doc.context.obj([id, id]);
  }
  return doc.save({
    useObjectStreams: opts.objectStreams ?? false,
    addDefaultPage: false,
    updateFieldAppearances: opts.updateFieldAppearances ?? true,
  });
}

export function text(
  page: PDFPage,
  font: PDFFont,
  value: string,
  x: number,
  y: number,
  size = 12,
): void {
  page.drawText(value, { x, y, size, font, color: rgb(0, 0, 0) });
}

export function name(value: string): PDFName {
  return PDFName.of(value);
}

export function str(value: string): PDFString {
  return PDFString.of(value);
}

/** Registers a raw (uncompressed) content stream as the page's only /Contents. */
export function setRawContent(doc: PDFDocument, page: PDFPage, content: string): void {
  const ref = doc.context.register(doc.context.stream(content));
  page.node.set(name('Contents'), ref);
}

/** Indexed access that fails loudly instead of yielding undefined. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index ${index} out of range`);
  return item;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function box(x: number, y: number, w: number, h: number): [number, number, number, number] {
  return [round2(x), round2(y), round2(w), round2(h)];
}

export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}
