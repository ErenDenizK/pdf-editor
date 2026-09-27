/**
 * Document tools (spec document-tools.md §3, §4, §7): custom Info keys and their XMP
 * mirror, embedded files, "Strip metadata", AES-256 passwords and permissions round-tripped
 * through PDFium and pdf-lib, and the diagnostics read in the assembly worker.
 */

import type { PDFArray } from '@cantoo/pdf-lib';
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import {
  ALL_PERMISSIONS,
  type DocumentMetadata,
  type MetadataStrip,
  type PermissionFlags,
  type SecurityPolicy,
  STRIP_ALL,
} from '@pdf-editor/document-model';
import annotationsUrl from '../../../test/fixtures/annotations.pdf?url';
import brokenXrefUrl from '../../../test/fixtures/broken-xref.pdf?url';
import encryptedUrl from '../../../test/fixtures/encrypted-aes-256.pdf?url';
import ownerOnlyUrl from '../../../test/fixtures/encrypted-owner-only-aes-256.pdf?url';
import rc4Url from '../../../test/fixtures/encrypted-rc4-40.pdf?url';
import formsAUrl from '../../../test/fixtures/forms-a.pdf?url';
import imagesUrl from '../../../test/fixtures/images.pdf?url';
import metadataUrl from '../../../test/fixtures/metadata-xmp.pdf?url';
import taggedUrl from '../../../test/fixtures/tagged.pdf?url';
import xfaUrl from '../../../test/fixtures/xfa-stub.pdf?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import { createAssemblerProxy } from '../src/worker/create-assembler-proxy';
import { makePdf, sid, vdoc, vpage, wasmUrl } from './helpers';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();
const assembler = new PdfLibAssembler();
let adapter: PdfiumAdapter;

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl, inspector: assembler });
});
afterAll(async () => {
  await adapter.destroy();
});

const latin1 = (bytes: ArrayBuffer) => new TextDecoder('latin1').decode(bytes);
const hex = (data: Uint8Array) => Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');

/** Inflates a zlib stream; undefined when the data is not Flate. */
async function inflate(data: Uint8Array): Promise<Uint8Array | undefined> {
  try {
    const stream = new Blob([data.slice()])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}

/**
 * The file as text: its raw bytes plus every Flate stream inflated (object streams
 * included), so data hidden in compressed objects is searched too.
 */
async function fileText(bytes: ArrayBuffer): Promise<string> {
  const raw = latin1(bytes);
  const parts = [raw];
  const data = new Uint8Array(bytes);
  const pattern = /stream\r?\n/g;
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    if (raw.slice(match.index - 3, match.index) === 'end') continue;
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    let stop = end;
    while (stop > start && (data[stop - 1] === 0x0a || data[stop - 1] === 0x0d)) stop--;
    const inflated = await inflate(data.subarray(start, stop));
    if (inflated) parts.push(new TextDecoder('latin1').decode(inflated));
    pattern.lastIndex = end;
  }
  return parts.join('\n');
}

/** Whether `text` occurs in the file as literal, hex or UTF-16BE hex string bytes. */
async function fileContains(bytes: ArrayBuffer, text: string): Promise<boolean> {
  const all = await fileText(bytes);
  const lower = all.toLowerCase();
  const ascii = hex(new TextEncoder().encode(text));
  const utf16 = hex(
    new Uint8Array(PDFHexString.fromText(text).asBytes()).subarray(2), // without the BOM
  );
  return all.includes(text) || lower.includes(ascii) || lower.includes(utf16);
}

/** Text of every decodable stream in the document (XMP, embedded files, content). */
function streamTexts(doc: PDFDocument): string[] {
  const out: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    try {
      out.push(new TextDecoder('latin1').decode(decodePDFRawStream(object).decode()));
    } catch {
      // Undecodable: skipped.
    }
  }
  return out;
}

/** Indirect objects (dictionaries or streams) whose /Type is `type`. */
function typedObjects(doc: PDFDocument, type: string): number {
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFRawStream ? object.dict : object;
    if (dict instanceof PDFDict && dict.get(PDFName.of('Type')) === PDFName.of(type)) count++;
  }
  return count;
}

function info(doc: PDFDocument): PDFDict {
  return doc.context.lookup(doc.context.trailerInfo.Info) as PDFDict;
}

function infoText(doc: PDFDocument, key: string): string | undefined {
  const value = info(doc).get(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}

function xmpOf(doc: PDFDocument): string | undefined {
  const stream = doc.context.lookup(doc.catalog.get(PDFName.of('Metadata')));
  if (!(stream instanceof PDFRawStream)) return undefined;
  return new TextDecoder().decode(decodePDFRawStream(stream).decode());
}

describe('custom Info keys', () => {
  test('are written to Info and mirrored in XMP under pdfx:', async () => {
    const SRC = sid('custom-src');
    const result = await assembler.assemble({
      document: vdoc([vpage({ kind: 'source', source: SRC, index: 0 })], {
        metadata: {
          policy: 'explicit',
          title: 'Quarterly report',
          custom: { Department: 'Legal & Co', 'Case.No': '42' },
        },
      }),
      sources: new Map([[SRC, await makePdf([{ size: [200, 200], text: 'x' }])]]),
      blobs: new Map(),
    });
    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(infoText(out, 'Title')).toBe('Quarterly report');
    expect(infoText(out, 'Department')).toBe('Legal & Co');
    expect(infoText(out, 'Case.No')).toBe('42');
    const xmp = xmpOf(out) ?? '';
    expect(xmp).toContain('xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/"');
    expect(xmp).toContain('<pdfx:Department>Legal &amp; Co</pdfx:Department>');
    expect(xmp).toContain('<pdfx:Case.No>42</pdfx:Case.No>');
    expect(result.report.metadataStripped).toBeUndefined();
  });

  test('are read on open and inherited from the first source', async () => {
    const bytes = await makePdf([{ size: [200, 200] }], (doc) => {
      info(doc).set(PDFName.of('Project'), PDFHexString.fromText('Ünicode ✓'));
    });
    const opened = await adapter.open(sid('custom-open'), bytes.slice(0));
    await adapter.close(sid('custom-open'));
    expect(opened.metadata.custom).toEqual({ Project: 'Ünicode ✓' });

    const SRC = sid('custom-inherit');
    const result = await assembler.assemble({
      document: vdoc([vpage({ kind: 'source', source: SRC, index: 0 })]),
      sources: new Map([[SRC, bytes]]),
      blobs: new Map(),
    });
    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(infoText(out, 'Project')).toBe('Ünicode ✓');
    expect(xmpOf(out)).toContain('<pdfx:Project>Ünicode ✓</pdfx:Project>');
  });
});

describe('embedded files and Strip metadata (metadata-xmp.pdf)', () => {
  const SRC = sid('meta');
  const STRIPPED = [
    'Jane Q. Fixture',
    'Metadata and XMP fixture',
    'Document information dictionary and XMP packet kept in sync',
    // (The file name "attachment.txt" is also drawn on the page, so it is not searched.)
    'Plain-text attachment fixture',
    'pdf-editor fixture generator',
  ];

  async function assembleWith(metadata: DocumentMetadata | undefined) {
    return assembler.assemble({
      document: vdoc([vpage({ kind: 'source', source: SRC, index: 0 })], {
        ...(metadata ? { metadata } : {}),
      }),
      sources: new Map([[SRC, await fetchBytes(metadataUrl)]]),
      blobs: new Map(),
    });
  }

  test('keeping metadata carries the attachment, Info and a fresh XMP packet', async () => {
    const result = await assembleWith({ policy: 'inherit-first-source' });
    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(out.getAuthor()).toBe('Jane Q. Fixture');
    const names = out.context.lookup(out.catalog.get(PDFName.of('Names'))) as PDFDict;
    const embedded = out.context.lookup(names.get(PDFName.of('EmbeddedFiles'))) as PDFDict;
    const pairs = out.context.lookup(embedded.get(PDFName.of('Names'))) as PDFArray;
    expect((pairs.get(0) as PDFHexString).decodeText()).toBe('attachment.txt');
    expect(streamTexts(out)).toContain('hello');
    expect(xmpOf(out)).toContain('Jane Q. Fixture');
  });

  test('stripping everything leaves none of the stripped strings in the file', async () => {
    const result = await assembleWith({ policy: 'explicit', strip: STRIP_ALL });
    const bytes = result.bytes;
    for (const text of STRIPPED) expect(await fileContains(bytes, text), text).toBe(false);
    const out = await PDFDocument.load(bytes, { updateMetadata: false });
    for (const text of streamTexts(out)) {
      for (const stripped of [...STRIPPED, 'hello', 'xmpmeta']) {
        expect(text.includes(stripped), stripped).toBe(false);
      }
    }
    expect(out.catalog.get(PDFName.of('Names'))).toBeUndefined();
    expect(out.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(typedObjects(out, 'Filespec')).toBe(0);
    expect(typedObjects(out, 'EmbeddedFile')).toBe(0);
    expect(typedObjects(out, 'Metadata')).toBe(0);
    // Minimal Info: Producer only, no dates.
    expect(
      info(out)
        .keys()
        .map((k) => k.decodeText()),
    ).toEqual(['Producer']);
    // A fresh file identifier.
    const source = await PDFDocument.load(await fetchBytes(metadataUrl), { updateMetadata: false });
    const idOf = (doc: PDFDocument) =>
      ((doc.context.trailerInfo.ID as PDFArray).get(0) as PDFHexString).asString();
    expect(idOf(out)).not.toBe(idOf(source));
    expect(result.report.metadataStripped).toMatchObject({
      attachments: 1,
      xmpPackets: 1,
      applied: STRIP_ALL,
    });
    expect(result.report.metadataStripped?.infoKeys).toBeGreaterThanOrEqual(6);
    // The page itself is intact.
    const opened = await adapter.open(sid('strip-check'), bytes.slice(0));
    await adapter.close(sid('strip-check'));
    expect(opened.pageCount).toBe(1);
    expect(opened.metadata.author).toBeUndefined();
  });

  test('a partial selection keeps what was not selected', async () => {
    const strip: MetadataStrip = { ...STRIP_ALL, info: false, customKeys: false, xmp: false };
    const result = await assembleWith({
      policy: 'explicit',
      author: 'Kept Author',
      strip,
    });
    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(out.getAuthor()).toBe('Kept Author');
    expect(xmpOf(out)).toContain('Kept Author');
    expect(out.catalog.get(PDFName.of('Names'))).toBeUndefined();
    expect(typedObjects(out, 'EmbeddedFile')).toBe(0);
    expect(await fileContains(result.bytes, 'Plain-text attachment fixture')).toBe(false);
  });
});

describe('Strip metadata on page and annotation level', () => {
  test('removes JavaScript, /AA, /PieceInfo, /Thumb, page XMP and annotation authors', async () => {
    const bytes = await makePdf([{ size: [300, 300], text: 'body' }], (doc) => {
      const { context } = doc;
      const page = doc.getPage(0);
      const js = context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("Secret script")') });
      page.node.set(PDFName.of('AA'), context.obj({ O: js }));
      page.node.set(
        PDFName.of('PieceInfo'),
        context.obj({ Illustrator: { Private: PDFString.of('Secret piece') } }),
      );
      page.node.set(
        PDFName.of('Thumb'),
        context.register(context.stream(new Uint8Array(12), { Width: 2, Height: 2 })),
      );
      page.node.set(
        PDFName.of('Metadata'),
        context.register(
          context.stream(new TextEncoder().encode('<x:xmpmeta>Secret page xmp</x:xmpmeta>'), {
            Type: 'Metadata',
            Subtype: 'XML',
          }),
        ),
      );
      const note = context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [10, 10, 30, 30],
          T: PDFHexString.fromText('Secret Author'),
          M: PDFString.of('D:20240101000000Z'),
          Contents: PDFHexString.fromText('Kept comment'),
        }),
      );
      const link = context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [40, 40, 80, 60],
          A: { S: 'JavaScript', JS: PDFString.of('Secret link script') },
        }),
      );
      page.node.set(PDFName.of('Annots'), context.obj([note, link]));
    });
    const SRC = sid('page-strip');
    const input = (strip?: MetadataStrip) => ({
      document: vdoc([vpage({ kind: 'source', source: SRC, index: 0 })], {
        metadata: { policy: 'explicit' as const, ...(strip ? { strip } : {}) },
      }),
      sources: new Map([[SRC, bytes.slice(0)]]),
      blobs: new Map(),
    });
    const kept = await assembler.assemble(input());
    expect(await fileContains(kept.bytes, 'Secret Author')).toBe(true);

    const result = await assembler.assemble(input(STRIP_ALL));
    for (const secret of [
      'Secret script',
      'Secret piece',
      'Secret page xmp',
      'Secret Author',
      'Secret link script',
    ]) {
      expect(await fileContains(result.bytes, secret), secret).toBe(false);
    }
    expect(await fileContains(result.bytes, 'Kept comment')).toBe(true);
    const out = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const page = out.getPage(0).node;
    for (const key of ['AA', 'PieceInfo', 'Thumb', 'Metadata']) {
      expect(page.get(PDFName.of(key)), key).toBeUndefined();
    }
    expect(result.report.metadataStripped).toMatchObject({
      javascript: 2,
      pieceInfo: 1,
      thumbnails: 1,
      xmpPackets: 1,
      annotationAuthors: 1,
    });
  });
});

describe('passwords and permissions', () => {
  const NONE: PermissionFlags = {
    print: false,
    printHighQuality: false,
    modify: false,
    copy: false,
    annotate: false,
    fillForms: false,
    accessibility: false,
    assemble: false,
  };
  const SETS: Record<string, PermissionFlags> = {
    all: ALL_PERMISSIONS,
    none: NONE,
    'print low quality only': { ...NONE, print: true },
    'print and copy': { ...NONE, print: true, printHighQuality: true, copy: true },
    'forms and accessibility': { ...NONE, fillForms: true, accessibility: true },
    'modify and assemble': { ...NONE, modify: true, assemble: true, annotate: true },
  };

  async function encrypt(security: SecurityPolicy): Promise<ArrayBuffer> {
    const SRC = sid('plain');
    const result = await assembler.assemble(
      {
        document: vdoc([vpage({ kind: 'source', source: SRC, index: 0 })], {
          metadata: { policy: 'explicit', title: 'Protected title' },
        }),
        sources: new Map([[SRC, await makePdf([{ size: [200, 200], text: 'secret body' }])]]),
        blobs: new Map(),
      },
      { security },
    );
    return result.bytes;
  }

  for (const [name, permissions] of Object.entries(SETS)) {
    test(`permission set "${name}" round-trips through PDFium and pdf-lib`, async () => {
      const bytes = await encrypt({
        algorithm: 'aes-256',
        userPassword: 'user pw',
        ownerPassword: 'owner pw',
        permissions,
      });
      const id = sid(`perm-${name}`);
      const opened = await adapter.open(id, bytes.slice(0), { password: 'user pw' });
      await adapter.close(id);
      expect(opened.flags).toMatchObject({
        encrypted: true,
        passwordProtected: true,
        securityHandler: 'aes-256',
        permissions,
      });
      expect(opened.metadata.title).toBe('Protected title');
      // With the owner password PDFium unlocks everything but still reports what /P says.
      const asOwner = await adapter.open(id, bytes.slice(0), { password: 'owner pw' });
      await adapter.close(id);
      expect(asOwner.flags.permissions).toEqual(permissions);
      const inspection = await assembler.inspect(bytes.slice(0), { password: 'user pw' });
      expect(inspection.encryption).toMatchObject({ handler: 'aes-256', v: 5, r: 6, permissions });
      const doc = await PDFDocument.load(bytes.slice(0), {
        password: 'user pw',
        updateMetadata: false,
      });
      expect(doc.getTitle()).toBe('Protected title');
    });
  }

  test('a wrong password fails, no password fails', async () => {
    const bytes = await encrypt({
      algorithm: 'aes-256',
      userPassword: 'right',
      permissions: ALL_PERMISSIONS,
    });
    await expect(
      adapter.open(sid('wrong'), bytes.slice(0), { password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'password-incorrect' });
    await expect(adapter.open(sid('none'), bytes.slice(0))).rejects.toMatchObject({
      code: 'password-required',
    });
    await expect(
      PDFDocument.load(bytes.slice(0), { password: 'wrong', updateMetadata: false }),
    ).rejects.toThrow();
    // Without an owner password a random one is set: the user password does not unlock.
    const opened = await adapter.open(sid('right'), bytes.slice(0), { password: 'right' });
    await adapter.close(sid('right'));
    expect(opened.flags.permissions).toEqual(ALL_PERMISSIONS);
    expect(await fileContains(bytes, 'secret body')).toBe(false);
  });

  test('owner-only output opens without a password and reports the restrictions', async () => {
    const permissions = { ...NONE, print: true, printHighQuality: true };
    const bytes = await encrypt({ algorithm: 'aes-256', ownerPassword: 'owner', permissions });
    const opened = await adapter.open(sid('owner-only'), bytes.slice(0));
    await adapter.close(sid('owner-only'));
    expect(opened.flags).toMatchObject({
      encrypted: true,
      passwordProtected: false,
      securityHandler: 'aes-256',
      permissions,
    });
    const doc = await PDFDocument.load(bytes.slice(0), { password: '', updateMetadata: false });
    expect(doc.getTitle()).toBe('Protected title');
  });

  test('fixtures report their handler and permissions', async () => {
    // /P -1852: print (bit 3) and high-quality print (bit 12) only.
    const printOnly = { ...NONE, print: true, printHighQuality: true };
    const cases: [string, string, string | undefined, string][] = [
      ['rc4-40', rc4Url, 'user', 'rc4-40'],
      ['aes-256', encryptedUrl, 'user', 'aes-256'],
      ['owner-only', ownerOnlyUrl, undefined, 'aes-256'],
    ];
    for (const [name, url, password, handler] of cases) {
      const id = sid(`fixture-${name}`);
      const opened = await adapter.open(
        id,
        await fetchBytes(url),
        password === undefined ? {} : { password },
      );
      await adapter.close(id);
      expect(opened.flags, name).toMatchObject({
        securityHandler: handler,
        passwordProtected: password !== undefined,
      });
      expect(opened.flags.permissions?.print, name).toBe(true);
      expect(opened.flags.permissions?.copy, name).toBe(false);
      if (name === 'owner-only') expect(opened.flags.permissions).toEqual(printOnly);
    }
  });
});

describe('diagnostics', () => {
  test('metadata-xmp: metadata findings, fonts and version', async () => {
    const d = await assembler.diagnose(await fetchBytes(metadataUrl));
    expect(d).toMatchObject({ pageCount: 1, partial: false, formType: 'none', tagged: false });
    expect(d.version).toMatch(/^1\.\d$/);
    expect(d.metadata).toMatchObject({ xmpPackets: 1, attachments: 1, javascript: 0 });
    expect(d.metadata.attachmentNames).toEqual(['attachment.txt']);
    expect(d.metadata.infoKeys).toEqual(
      expect.arrayContaining(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']),
    );
    expect(d.fonts.total).toBeGreaterThanOrEqual(1);
    expect(d.fonts.list[0]).toMatchObject({ name: 'Helvetica', embedded: false, subset: false });
    expect(d.warnings).toEqual([]);
  });

  test('images: count, pixel size and approximate DPI', async () => {
    const d = await assembler.diagnose(await fetchBytes(imagesUrl));
    expect(d.images.count).toBe(3);
    for (const image of d.images.list) {
      expect(image.width).toBeGreaterThan(0);
      expect(image.dpi).toBeGreaterThan(0);
    }
    expect(d.images.list.map((i) => i.filter)).toEqual(
      expect.arrayContaining(['FlateDecode', 'DCTDecode']),
    );
    expect(d.images.medianDpi).toBeGreaterThan(0);
  });

  test('forms, XFA, tagging, annotations, damage', async () => {
    const forms = await assembler.diagnose(await fetchBytes(formsAUrl));
    expect(forms.formType).toBe('acroform');
    expect(forms.formFields).toBeGreaterThanOrEqual(6);
    expect((await assembler.diagnose(await fetchBytes(xfaUrl))).formType).toBe('xfa');
    expect((await assembler.diagnose(await fetchBytes(taggedUrl))).tagged).toBe(true);
    const annotations = await assembler.diagnose(await fetchBytes(annotationsUrl));
    expect(annotations.annotations).toEqual({
      total: 4,
      bySubtype: { Highlight: 1, Square: 1, Text: 1, Ink: 1 },
    });
    expect(annotations.metadata.annotationAuthors).toBeGreaterThanOrEqual(0);
    const broken = await assembler.diagnose(await fetchBytes(brokenXrefUrl));
    expect(broken.warnings.join(' ')).toMatch(/Cross-reference table damaged/);
  });

  test('encrypted: complete with the password, partial without, never rejects', async () => {
    const withPassword = await assembler.diagnose(await fetchBytes(encryptedUrl), {
      password: 'user',
    });
    expect(withPassword).toMatchObject({ partial: false, pageCount: 3 });
    expect(withPassword.encryption).toMatchObject({ handler: 'aes-256', r: 6 });
    const without = await assembler.diagnose(await fetchBytes(encryptedUrl));
    expect(without.partial).toBe(true);
    expect(without.encryption?.handler).toBe('aes-256');
    const ownerOnly = await assembler.diagnose(await fetchBytes(ownerOnlyUrl));
    expect(ownerOnly.partial).toBe(false);
    const garbage = await assembler.diagnose(new TextEncoder().encode('not a pdf').buffer);
    expect(garbage.partial).toBe(true);
  });

  test('runs in the assembly worker', async () => {
    const worker = new Worker(new URL('../src/worker/assembler.worker.ts', import.meta.url), {
      type: 'module',
    });
    const proxy = createAssemblerProxy(worker);
    try {
      const d = await proxy.diagnose(await fetchBytes(metadataUrl));
      expect(d.metadata.attachments).toBe(1);
    } finally {
      proxy.dispose();
    }
  });
});
