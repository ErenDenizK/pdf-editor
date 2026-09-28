/**
 * Helpers for the text-edit tests (browser mode): a hosted engine with an adapter and a
 * text editor on the calling thread, fixtures, and pdf-lib readers for content streams.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
} from '@cantoo/pdf-lib';
import type { SourceId } from '@pdf-editor/document-model';

import { sid, toBuffer, wasmUrl } from '../../test/helpers';
import { createHostedEngine, type HostedEngine } from '../pdfium/host';
import { PdfiumAdapter } from '../pdfium/pdfium-adapter';
import type { LocatedRun } from '../types';
import { createTextEditor, type HostedTextEditor } from './editor';

export interface Harness {
  readonly host: HostedEngine;
  readonly adapter: PdfiumAdapter;
  readonly editor: HostedTextEditor;
  /** Opens `bytes` (copied) under a fresh source id. */
  open(bytes: ArrayBuffer): Promise<SourceId>;
}

let counter = 0;

export async function createHarness(): Promise<Harness> {
  const host = await createHostedEngine({ wasm: wasmUrl });
  const adapter = new PdfiumAdapter({ wasmUrl, engineFactory: () => host.engine });
  const editor = createTextEditor(host);
  return {
    host,
    adapter,
    editor,
    async open(bytes) {
      const id = sid(`te-${++counter}`);
      await adapter.open(id, bytes.slice(0));
      return id;
    },
  };
}

const FIXTURES = new Map<string, ArrayBuffer>();

export async function fixture(url: string): Promise<ArrayBuffer> {
  let bytes = FIXTURES.get(url);
  if (!bytes) {
    bytes = await (await fetch(url)).arrayBuffer();
    FIXTURES.set(url, bytes);
  }
  return bytes.slice(0);
}

/** The run containing `text` (the `occurrence`-th one). */
export async function runWith(
  harness: Harness,
  source: SourceId,
  pageIndex: number,
  text: string,
  predicate: (run: LocatedRun) => boolean = () => true,
): Promise<LocatedRun> {
  const runs = await harness.editor.locateRuns(source, pageIndex);
  const run = runs.find((r) => r.text.includes(text) && predicate(r));
  if (!run) throw new Error(`No run with "${text}" in ${JSON.stringify(runs.map((r) => r.text))}`);
  return run;
}

/** Offsets of `word` in the run. */
export function span(run: LocatedRun, word: string): { start: number; end: number } {
  const start = run.text.indexOf(word);
  if (start < 0) throw new Error(`"${word}" not in "${run.text}"`);
  return { start, end: start + word.length };
}

/** Text of each run of a page as the adapter extracts it (fresh after edits). */
export async function pageText(harness: Harness, source: SourceId, pageIndex: number) {
  return (await harness.adapter.getPageText(source, pageIndex)).map((r) => r.text);
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

function streamText(stream: unknown): string {
  if (!(stream instanceof PDFRawStream)) return '';
  return latin1(decodePDFRawStream(stream).decode());
}

/** The inflated page content plus its Form XObject streams. */
export async function inflatedContent(
  bytes: ArrayBuffer,
  pageIndex: number,
): Promise<{ page: string; forms: string[] }> {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  const page = doc.getPage(pageIndex);
  const contents = page.node.get(PDFName.of('Contents'));
  const resolved = contents instanceof PDFRef ? doc.context.lookup(contents) : contents;
  const parts: string[] = [];
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) parts.push(streamText(resolved.lookup(i)));
  } else {
    parts.push(streamText(resolved));
  }
  const forms: string[] = [];
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xobjects?.entries() ?? []) {
    const obj = doc.context.lookup(ref);
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Form')) {
      forms.push(streamText(obj));
    }
  }
  return { page: parts.join('\n'), forms };
}

/** WinAnsi text as it can appear in a content stream: literal, upper and lower hex. */
export function encodings(text: string): string[] {
  const hex = Array.from(text)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return [`(${text}`, hex.toUpperCase(), hex.toLowerCase()];
}

/** Indirect streams (reachable or not) whose inflated bytes contain `text` in any encoding. */
export async function streamsContaining(bytes: ArrayBuffer, text: string): Promise<number> {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  let hits = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    let decoded = '';
    try {
      decoded = streamText(obj);
    } catch {
      continue;
    }
    if (encodings(text).some((e) => decoded.includes(e))) hits++;
  }
  return hits;
}

/**
 * A one-page PDF with raw content: F1 = Helvetica (WinAnsi); `forms` become Form XObjects
 * using the same fonts.
 */
export async function rawPdf(options: {
  content: string;
  forms?: Record<string, string>;
  size?: [number, number];
}): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage(options.size ?? [400, 200]);
  const helvetica = ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }),
  );
  const fonts = { F1: helvetica };
  const xobjects: Record<string, PDFRef> = {};
  for (const [name, content] of Object.entries(options.forms ?? {})) {
    xobjects[name] = ctx.register(
      ctx.stream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 400, 200],
        Resources: { Font: fonts },
      }),
    );
  }
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: fonts, XObject: xobjects }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(options.content)));
  return toBuffer(await doc.save());
}

/** Origins of every character of a page, via a fresh open of `bytes`. */
export async function charOrigins(
  harness: Harness,
  bytes: ArrayBuffer,
  pageIndex: number,
): Promise<{ text: string; origins: { x: number; y: number }[] }> {
  const id = await harness.open(bytes);
  const runs = await harness.editor.locateRuns(id, pageIndex);
  await harness.adapter.close(id);
  const glyphs = runs.flatMap((r) => r.glyphs);
  return { text: glyphs.map((g) => g.text).join(''), origins: glyphs.map((g) => g.origin) };
}

export function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** The run whose first glyph sits on `baseline` (text-edit-fonts.pdf lines, README table). */
export function onBaseline(baseline: number): (run: LocatedRun) => boolean {
  return (run) => Math.abs((run.glyphs[0]?.origin.y ?? 0) - baseline) < 0.01;
}

/** The rejection reason of `promise` (fails when it resolves). */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}
