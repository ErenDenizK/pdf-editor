/**
 * Deterministic generator for the PDF test corpus in test/fixtures/.
 *
 *   pnpm --filter @pdf-editor/fixtures-tool generate          # (re)write fixtures
 *   pnpm --filter @pdf-editor/fixtures-tool generate --check  # rebuild in memory, compare
 *
 * Every fixture is built from scratch here (no third-party content), so the
 * corpus is redistributable under the repository licence. Determinism: fixed
 * Info/XMP dates, fixed trailer /ID derived from the file name, and a seeded
 * PRNG in place of Math.random / crypto.getRandomValues while each fixture is
 * built (pdf-lib's encryption draws keys, salts and IVs from the latter).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  type PDFFont,
  PDFHexString,
  PDFName,
  type PDFObject,
  type PDFPage,
  PDFRef,
  PDFStream,
  PDFString,
  PageSizes,
  StandardFonts,
  degrees,
  rgb,
} from '@cantoo/pdf-lib';
import {
  CREATOR,
  type EncryptionExpectation,
  type Expectations,
  FIXED_DATE,
  FIXED_DATE_XMP,
  FIXTURES_DIR,
  MAX_CORPUS_BYTES,
  type Manifest,
  type ManifestEntry,
  PDF_LIB_VERSION,
  PRODUCER,
  type PageExpectation,
  REPO_ROOT,
  fileIdFor,
  seededRandom,
  sha256,
  withDeterministicRandom,
} from './lib/common.ts';
import { encodeJpeg } from './lib/jpeg.ts';
import { encodePng } from './lib/png.ts';

const A4 = PageSizes.A4; // [595.28, 841.89]
const LETTER = PageSizes.Letter; // [612, 792]

interface Built {
  bytes: Uint8Array;
  expect: Expectations;
}

interface FixtureDef {
  file: string;
  tags: string[];
  summary: string;
  behavior: string;
  howGenerated: string;
  passwords?: { user: string; owner: string };
  derivedFrom?: string;
  build: (built: Map<string, Uint8Array>) => Promise<Built>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function newDoc(title: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(title);
  doc.setCreator(CREATOR);
  doc.setProducer(PRODUCER);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  return doc;
}

interface SaveOpts {
  objectStreams?: boolean;
  updateFieldAppearances?: boolean;
}

async function save(doc: PDFDocument, file: string, opts: SaveOpts = {}): Promise<Uint8Array> {
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

function text(page: PDFPage, font: PDFFont, value: string, x: number, y: number, size = 12): void {
  page.drawText(value, { x, y, size, font, color: rgb(0, 0, 0) });
}

function name(value: string): PDFName {
  return PDFName.of(value);
}

function str(value: string): PDFString {
  return PDFString.of(value);
}

/** Registers a raw (uncompressed) content stream as the page's only /Contents. */
function setRawContent(doc: PDFDocument, page: PDFPage, content: string): void {
  const ref = doc.context.register(doc.context.stream(content));
  page.node.set(name('Contents'), ref);
}

/** Indexed access that fails loudly instead of yielding undefined. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index ${index} out of range`);
  return item;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function box(x: number, y: number, w: number, h: number): [number, number, number, number] {
  return [round2(x), round2(y), round2(w), round2(h)];
}

// ---------------------------------------------------------------------------
// 1. simple-text
// ---------------------------------------------------------------------------

async function buildSimpleText(): Promise<Built> {
  const doc = await newDoc('Simple text fixture');
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const pages: PageExpectation[] = [];
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage(LETTER);
    const marker = `PAGE ${i} OF simple-text`;
    text(page, font, marker, 72, 700, 24);
    text(
      page,
      font,
      `This is page ${i} of a three-page US Letter document set in Helvetica.`,
      72,
      660,
    );
    text(page, font, 'The quick brown fox jumps over the lazy dog.', 72, 640);
    pages.push({
      page: i,
      mediaBox: box(0, 0, 612, 792),
      rotate: 0,
      displayedSize: [612, 792],
      markers: [marker],
    });
  }
  return {
    bytes: await save(doc, 'simple-text.pdf'),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 3,
      pages,
      info: { Title: 'Simple text fixture' },
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. rotated-pages
// ---------------------------------------------------------------------------

async function buildRotatedPages(): Promise<Built> {
  const doc = await newDoc('Rotated pages fixture');
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const pages: PageExpectation[] = [];
  [0, 90, 180, 270].forEach((rotation, index) => {
    const n = index + 1;
    const page = doc.addPage(A4);
    page.setRotation(degrees(rotation));
    const marker = `PAGE ${n} ROTATE ${rotation} OF rotated-pages`;
    text(page, font, marker, 72, 760, 20);
    text(page, font, 'This line is at the top of the unrotated page (user space).', 72, 730);
    text(page, font, 'BOTTOM-LEFT CORNER OF USER SPACE', 20, 20, 10);
    const swapped = rotation % 180 !== 0;
    pages.push({
      page: n,
      mediaBox: box(0, 0, A4[0], A4[1]),
      rotate: rotation,
      displayedSize: swapped ? [A4[1], A4[0]] : [A4[0], A4[1]],
      markers: [marker],
    });
  });
  return {
    bytes: await save(doc, 'rotated-pages.pdf'),
    expect: { pdfLibLoad: 'ok', pageCount: 4, pages, xref: 'table', fileIdDeterministic: true },
  };
}

// ---------------------------------------------------------------------------
// 3. mixed-sizes
// ---------------------------------------------------------------------------

async function buildMixedSizes(): Promise<Built> {
  const doc = await newDoc('Mixed page sizes fixture');
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const specs: { size: [number, number]; rotate: number; marker: string; fontSize: number }[] = [
    { size: [A4[0], A4[1]], rotate: 0, marker: 'PAGE 1 A4 PORTRAIT', fontSize: 20 },
    { size: [LETTER[0], LETTER[1]], rotate: 0, marker: 'PAGE 2 LETTER PORTRAIT', fontSize: 20 },
    { size: [A4[0], A4[1]], rotate: 90, marker: 'PAGE 3 A4 LANDSCAPE VIA ROTATE 90', fontSize: 20 },
    { size: [A4[1], A4[0]], rotate: 0, marker: 'PAGE 4 A4 LANDSCAPE VIA MEDIABOX', fontSize: 20 },
    { size: [200, 200], rotate: 0, marker: 'PAGE 5 SQUARE', fontSize: 14 },
  ];
  const pages: PageExpectation[] = specs.map((spec, index) => {
    const page = doc.addPage(spec.size);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    text(page, font, spec.marker, 20, spec.size[1] - 40, spec.fontSize);
    const [w, h] = spec.size;
    return {
      page: index + 1,
      mediaBox: box(0, 0, w, h),
      rotate: spec.rotate,
      displayedSize: spec.rotate % 180 ? [round2(h), round2(w)] : [round2(w), round2(h)],
      markers: [spec.marker],
    };
  });
  return {
    bytes: await save(doc, 'mixed-sizes.pdf'),
    expect: { pdfLibLoad: 'ok', pageCount: 5, pages, xref: 'table', fileIdDeterministic: true },
  };
}

// ---------------------------------------------------------------------------
// 4. outline-named-dests
// ---------------------------------------------------------------------------

interface OutlineSpec {
  title: PDFString | PDFHexString;
  dest?: PDFObject;
  action?: PDFObject;
  open?: boolean;
  children?: OutlineSpec[];
}

function countIfOpen(item: OutlineSpec): number {
  return (item.children ?? []).reduce((n, child) => n + 1 + visibleDescendants(child), 0);
}

function visibleDescendants(item: OutlineSpec): number {
  return item.open ? countIfOpen(item) : 0;
}

/** Writes a /Outlines tree (ISO 32000-2 §12.3.3) and returns the root /Count. */
function writeOutline(doc: PDFDocument, items: OutlineSpec[]): number {
  const ctx = doc.context;
  const rootRef = ctx.nextRef();

  const writeLevel = (level: OutlineSpec[], parentRef: PDFRef): [PDFRef, PDFRef] => {
    const refs = level.map(() => ctx.nextRef());
    level.forEach((item, i) => {
      const ref = at(refs, i);
      const dict = ctx.obj({ Title: item.title, Parent: parentRef });
      if (i > 0) dict.set(name('Prev'), at(refs, i - 1));
      if (i < level.length - 1) dict.set(name('Next'), at(refs, i + 1));
      if (item.dest) dict.set(name('Dest'), item.dest);
      if (item.action) dict.set(name('A'), item.action);
      if (item.children?.length) {
        const [first, last] = writeLevel(item.children, ref);
        dict.set(name('First'), first);
        dict.set(name('Last'), last);
        const count = countIfOpen(item);
        dict.set(name('Count'), ctx.obj(item.open ? count : -count));
      }
      ctx.assign(ref, dict);
    });
    return [at(refs, 0), at(refs, refs.length - 1)];
  };

  const [first, last] = writeLevel(items, rootRef);
  const total = items.reduce((n, item) => n + 1 + visibleDescendants(item), 0);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: total }));
  doc.catalog.set(name('Outlines'), rootRef);
  doc.catalog.set(name('PageMode'), name('UseOutlines'));
  return total;
}

async function buildOutline(): Promise<Built> {
  const doc = await newDoc('Outline and named destinations fixture');
  const ctx = doc.context;
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const headings = [
    'Chapter 1: Introduction',
    'Links',
    'Chapter 2 - Methods',
    '2.1 Setup',
    '2.2 Results and 2.2.1 Details',
    'Appendix',
  ];
  const pages = headings.map((heading, i) => {
    const page = doc.addPage(LETTER);
    text(page, font, `PAGE ${i + 1} OF outline-named-dests`, 72, 740, 10);
    text(page, font, heading, 72, 700, 24);
    return page;
  });
  const refs = pages.map((p) => p.ref);
  const ref = (i: number): PDFRef => at(refs, i);
  text(at(pages, 4), font, '2.2.1 Details (FitH 300)', 72, 300, 16);

  // Named destinations, both flavours: the PDF 1.2 name tree (/Names /Dests,
  // keys sorted, values either a dest array or a << /D array >> dict) and the
  // PDF 1.1 catalog /Dests dictionary (keys are names).
  const destTree = ctx.obj({
    Names: [
      str('chapter-2'),
      ctx.obj([ref(2), 'XYZ', 72, 730, 0]),
      str('section-2.1'),
      ctx.obj({ D: [ref(3), 'FitH', 730] }),
    ],
  });
  doc.catalog.set(name('Names'), ctx.obj({ Dests: ctx.register(destTree) }));
  doc.catalog.set(name('Dests'), ctx.register(ctx.obj({ appendix: [ref(5), 'Fit'] })));

  const visible = writeOutline(doc, [
    { title: str('Chapter 1: Introduction'), dest: ctx.obj([ref(0), 'XYZ', 72, 730, 0]) },
    {
      // En dash forces a UTF-16BE text string.
      title: PDFHexString.fromText('Chapter 2 – Methods'),
      dest: str('chapter-2'),
      open: true,
      children: [
        { title: str('2.1 Setup'), action: ctx.obj({ S: 'GoTo', D: str('section-2.1') }) },
        {
          title: str('2.2 Results'),
          dest: ctx.obj([ref(4), 'Fit']),
          open: false,
          children: [{ title: str('2.2.1 Details'), dest: ctx.obj([ref(4), 'FitH', 300]) }],
        },
      ],
    },
    { title: str('Appendix'), dest: name('appendix') },
  ]);

  // Page 2: two internal links and one URI link.
  const linkPage = at(pages, 1);
  const linkSpecs: { label: string; y: number; extra: Record<string, PDFObject> }[] = [
    {
      label: 'Go to page 4 (explicit GoTo action)',
      y: 600,
      extra: { A: ctx.obj({ S: 'GoTo', D: [ref(3), 'XYZ', null, null, null] }) },
    },
    {
      label: 'Go to Chapter 2 (named destination chapter-2)',
      y: 560,
      extra: { Dest: str('chapter-2') },
    },
    {
      label: 'Open https://example.com/ (URI action)',
      y: 520,
      extra: { A: ctx.obj({ S: 'URI', URI: str('https://example.com/') }) },
    },
  ];
  const annots = linkSpecs.map((spec, i) => {
    text(linkPage, font, spec.label, 72, spec.y, 14);
    const width = font.widthOfTextAtSize(spec.label, 14);
    linkPage.drawLine({
      start: { x: 72, y: spec.y - 2 },
      end: { x: 72 + width, y: spec.y - 2 },
      thickness: 0.5,
      color: rgb(0, 0, 0.8),
    });
    const dict = ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [72, spec.y - 4, round2(72 + width), spec.y + 14],
      Border: [0, 0, 0],
      F: 4,
      H: 'I',
      P: linkPage.ref,
      NM: str(`fixture-link-${i + 1}`),
    });
    for (const [key, value] of Object.entries(spec.extra)) dict.set(name(key), value);
    return ctx.register(dict);
  });
  linkPage.node.set(name('Annots'), ctx.obj(annots));

  return {
    bytes: await save(doc, 'outline-named-dests.pdf'),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 6,
      pages: headings.map((_, i) => ({
        page: i + 1,
        mediaBox: box(0, 0, 612, 792),
        rotate: 0,
        markers: [`PAGE ${i + 1} OF outline-named-dests`],
      })),
      outline: [
        { title: 'Chapter 1: Introduction', page: 1, target: 'explicit-dest' },
        {
          title: 'Chapter 2 – Methods',
          page: 3,
          target: 'named-dest-string',
          destName: 'chapter-2',
          open: true,
          children: [
            { title: '2.1 Setup', page: 4, target: 'goto-action-named', destName: 'section-2.1' },
            {
              title: '2.2 Results',
              page: 5,
              target: 'explicit-dest',
              open: false,
              children: [{ title: '2.2.1 Details', page: 5, target: 'explicit-dest' }],
            },
          ],
        },
        { title: 'Appendix', page: 6, target: 'named-dest-name', destName: 'appendix' },
      ],
      outlineVisibleCount: visible,
      namedDests: [
        { name: 'chapter-2', page: 3, tree: 'Names/Dests' },
        { name: 'section-2.1', page: 4, tree: 'Names/Dests' },
        { name: 'appendix', page: 6, tree: 'Catalog/Dests' },
      ],
      links: [
        { page: 2, kind: 'goto-explicit', targetPage: 4 },
        { page: 2, kind: 'dest-named', targetPage: 3, destName: 'chapter-2' },
        { page: 2, kind: 'uri', uri: 'https://example.com/' },
      ],
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. page-labels
// ---------------------------------------------------------------------------

async function buildPageLabels(): Promise<Built> {
  const doc = await newDoc('Page labels fixture');
  const ctx = doc.context;
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const labels = ['i', 'ii', 'iii', '1', '2', '3', 'A-1', 'A-2'];
  const pages: PageExpectation[] = labels.map((label, i) => {
    const page = doc.addPage(LETTER);
    const marker = `PHYSICAL PAGE ${i + 1} LABEL ${label}`;
    text(page, font, marker, 72, 700, 20);
    return { page: i + 1, mediaBox: box(0, 0, 612, 792), rotate: 0, markers: [marker] };
  });
  doc.catalog.set(
    name('PageLabels'),
    ctx.register(
      ctx.obj({
        Nums: [
          0,
          ctx.obj({ Type: 'PageLabel', S: 'r' }),
          3,
          ctx.obj({ Type: 'PageLabel', S: 'D', St: 1 }),
          6,
          ctx.obj({ Type: 'PageLabel', S: 'D', P: str('A-'), St: 1 }),
        ],
      }),
    ),
  );
  return {
    bytes: await save(doc, 'page-labels.pdf'),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 8,
      pages,
      pageLabels: labels,
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 6. forms-a / forms-b (and 13. xfa-stub)
// ---------------------------------------------------------------------------

const COUNTRIES = ['Canada', 'France', 'Germany', 'Japan', 'United States'];

async function buildFormsDoc(
  variant: 'a' | 'b',
  title: string,
): Promise<{ doc: PDFDocument; expect: Expectations }> {
  const doc = await newDoc(title);
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  const p1 = doc.addPage(LETTER);
  const p2 = doc.addPage(LETTER);
  const a = variant === 'a';
  const file = `forms-${variant}`;
  text(p1, font, `PAGE 1 OF ${file}`, 72, 740, 10);
  text(p2, font, `PAGE 2 OF ${file}`, 72, 740, 10);

  const values = {
    name: a ? 'Alice Example' : 'Bob Example',
    agree: a,
    choice: a ? 'optionA' : 'optionB',
    country: a ? 'France' : 'Japan',
    city: a ? 'Paris' : 'Tokyo',
    unique: a ? 'Present only in forms-a' : 'Present only in forms-b',
  };
  const uniqueName = a ? 'only_in_a' : 'only_in_b';

  text(p1, font, 'Name', 72, 686);
  const nameField = form.createTextField('name');
  nameField.setText(values.name);
  nameField.addToPage(p1, { x: 180, y: 680, width: 240, height: 22, font });

  text(p1, font, 'I agree', 72, 646);
  const agree = form.createCheckBox('agree');
  agree.addToPage(p1, { x: 180, y: 640, width: 18, height: 18 });
  if (values.agree) agree.check();
  else agree.uncheck();

  text(p1, font, 'Choice', 72, 606);
  const choice = form.createRadioGroup('choice');
  text(p1, font, 'Option A', 206, 606);
  choice.addOptionToPage('optionA', p1, { x: 180, y: 600, width: 18, height: 18 });
  text(p1, font, 'Option B', 316, 606);
  choice.addOptionToPage('optionB', p1, { x: 290, y: 600, width: 18, height: 18 });
  choice.select(values.choice);

  text(p1, font, 'Country', 72, 566);
  const country = form.createDropdown('country');
  country.addOptions(COUNTRIES);
  country.select(values.country);
  country.addToPage(p1, { x: 180, y: 560, width: 160, height: 22, font });

  text(p2, font, 'City (address.city)', 72, 686);
  const city = form.createTextField('address.city');
  city.setText(values.city);
  city.addToPage(p2, { x: 200, y: 680, width: 200, height: 22, font });

  text(p2, font, uniqueName, 72, 646);
  const unique = form.createTextField(uniqueName);
  unique.setText(values.unique);
  unique.addToPage(p2, { x: 200, y: 640, width: 260, height: 22, font });

  if (a) {
    // Rely on the viewer: /NeedAppearances true and no /AP on text and choice
    // widgets. Button widgets keep their /AP because their on-state names
    // (/AS, /AP /N keys) are what encodes the value.
    form.acroForm.dict.set(name('NeedAppearances'), doc.context.obj(true));
    for (const field of [nameField, country, city, unique]) {
      for (const widget of field.acroField.getWidgets()) widget.dict.delete(name('AP'));
    }
  }

  const expect: Expectations = {
    pdfLibLoad: 'ok',
    pageCount: 2,
    pages: [1, 2].map((n) => ({
      page: n,
      mediaBox: box(0, 0, 612, 792),
      rotate: 0,
      markers: [`PAGE ${n} OF ${file}`],
    })),
    fields: [
      { name: 'name', type: 'text', value: values.name, page: 1, hasAppearance: !a },
      { name: 'agree', type: 'checkbox', value: values.agree, page: 1, hasAppearance: true },
      {
        name: 'choice',
        type: 'radio',
        value: values.choice,
        page: 1,
        options: ['optionA', 'optionB'],
        hasAppearance: true,
      },
      {
        name: 'country',
        type: 'dropdown',
        value: values.country,
        page: 1,
        options: COUNTRIES,
        hasAppearance: !a,
      },
      { name: 'address.city', type: 'text', value: values.city, page: 2, hasAppearance: !a },
      { name: uniqueName, type: 'text', value: values.unique, page: 2, hasAppearance: !a },
    ],
    needAppearances: a,
    xfa: false,
    xref: 'table',
    fileIdDeterministic: true,
  };
  return { doc, expect };
}

async function buildForms(variant: 'a' | 'b'): Promise<Built> {
  const { doc, expect } = await buildFormsDoc(variant, `AcroForm fixture ${variant.toUpperCase()}`);
  return {
    bytes: await save(doc, `forms-${variant}.pdf`, { updateFieldAppearances: variant === 'b' }),
    expect,
  };
}

const XDP = `<?xml version="1.0" encoding="UTF-8"?>
<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">
  <config xmlns="http://www.xfa.org/schema/xci/3.0/">
    <present><pdf><version>1.7</version></pdf></present>
  </config>
  <template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
    <subform name="form1" layout="tb" locale="en_US">
      <pageSet>
        <pageArea name="Page1" id="Page1">
          <contentArea x="0.25in" y="0.25in" w="8in" h="10.5in"/>
          <medium stock="letter" short="8.5in" long="11in"/>
        </pageArea>
      </pageSet>
      <subform w="8in" h="10.5in">
        <field name="name" w="3in" h="9mm">
          <ui><textEdit/></ui>
          <caption><value><text>Name</text></value></caption>
        </field>
      </subform>
    </subform>
  </template>
  <xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">
    <xfa:data><form1><name>Alice Example</name></form1></xfa:data>
  </xfa:datasets>
</xdp:xdp>
`;

async function buildXfaStub(): Promise<Built> {
  const { doc, expect } = await buildFormsDoc('a', 'XFA detection stub fixture');
  const xfa = doc.context.register(doc.context.stream(XDP));
  doc.getForm().acroForm.dict.set(name('XFA'), xfa);
  return {
    bytes: await save(doc, 'xfa-stub.pdf', { updateFieldAppearances: false }),
    expect: { ...expect, xfa: true, pdfLibLoadOptions: { preserveXFA: true } },
  };
}

// ---------------------------------------------------------------------------
// 7. encrypted-*
// ---------------------------------------------------------------------------

type Algorithm = EncryptionExpectation['algorithm'];

/**
 * @cantoo/pdf-lib 2.11.1's writer encrypts stream data only and leaves every
 * string in plaintext (PDFWriter.encrypt handles PDFStream only), which
 * violates ISO 32000-2 §7.6.2 and makes RC4 readers decode the Info dict to
 * garbage. Encrypt all strings of every indirect object except /Encrypt itself
 * with that object's key before saving, so the fixtures are spec-conformant.
 */
function encryptStrings(doc: PDFDocument): void {
  const security = doc.context.security;
  const encryptRef = doc.context.trailerInfo.Encrypt;
  if (!security) return;
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (encryptRef instanceof PDFRef && ref === encryptRef) continue;
    const fn = security.getEncryptFn(ref.objectNumber, ref.generationNumber);
    const transform = (value: PDFObject): PDFObject | undefined => {
      if (value instanceof PDFString || value instanceof PDFHexString) {
        return PDFHexString.fromBytes(fn(value.asBytes()));
      }
      if (value instanceof PDFDict) {
        for (const [key, child] of value.entries()) {
          const next = transform(child);
          if (next) value.set(key, next);
        }
      } else if (value instanceof PDFArray) {
        for (let i = 0; i < value.size(); i++) {
          const next = transform(value.get(i));
          if (next) value.set(i, next);
        }
      } else if (value instanceof PDFStream) {
        transform(value.dict);
      }
      return undefined;
    };
    transform(object);
  }
}

async function buildEncrypted(
  source: Uint8Array,
  algorithm: Algorithm,
  userPassword: string,
  ownerPassword: string,
): Promise<Built> {
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  const weak = algorithm.startsWith('RC4');
  doc.encrypt({
    userPassword,
    ownerPassword,
    algorithm,
    allowWeakCryptography: weak,
    permissions: {
      printing: algorithm === 'RC4-40' ? true : 'highResolution',
      modifying: false,
      copying: false,
    },
  });
  encryptStrings(doc);
  const encrypt = doc.context.lookup(doc.context.trailerInfo.Encrypt, PDFDict);
  const num = (key: string): number => {
    const value = encrypt.get(name(key));
    return value ? Number(value.toString()) : 0;
  };
  const v = num('V');
  const lengthBits = num('Length') || 40;
  const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  return {
    bytes,
    expect: {
      pdfLibLoad: 'ok',
      pdfLibLoadOptions: { password: userPassword },
      pageCount: 3,
      pages: [1, 2, 3].map((n) => ({
        page: n,
        mediaBox: box(0, 0, 612, 792),
        rotate: 0,
        markers: [`PAGE ${n} OF simple-text`],
      })),
      encryption: {
        algorithm,
        filter: 'Standard',
        v,
        r: num('R'),
        lengthBits: v === 5 ? 256 : lengthBits,
        p: num('P'),
        permissions: { print: true, modify: false, copy: false },
        userPassword,
        ownerPassword,
      },
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 8. metadata-xmp
// ---------------------------------------------------------------------------

const META = {
  Title: 'Metadata and XMP fixture',
  Author: 'Jane Q. Fixture',
  Subject: 'Document information dictionary and XMP packet kept in sync',
  Keywords: ['pdf-editor', 'fixture', 'metadata', 'xmp'],
};

const BOM = String.fromCharCode(0xfeff);

function xmpPacket(): string {
  const padding = `${' '.repeat(99)}\n`.repeat(20);
  return `<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <dc:format>application/pdf</dc:format>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${META.Title}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${META.Author}</rdf:li></rdf:Seq></dc:creator>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${META.Subject}</rdf:li></rdf:Alt></dc:description>
      <dc:subject><rdf:Bag>${META.Keywords.map((k) => `<rdf:li>${k}</rdf:li>`).join('')}</rdf:Bag></dc:subject>
      <pdf:Keywords>${META.Keywords.join(' ')}</pdf:Keywords>
      <pdf:Producer>${PRODUCER}</pdf:Producer>
      <xmp:CreatorTool>${CREATOR}</xmp:CreatorTool>
      <xmp:CreateDate>${FIXED_DATE_XMP}</xmp:CreateDate>
      <xmp:ModifyDate>${FIXED_DATE_XMP}</xmp:ModifyDate>
      <xmp:MetadataDate>${FIXED_DATE_XMP}</xmp:MetadataDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
${padding}<?xpacket end="w"?>`;
}

async function buildMetadata(): Promise<Built> {
  const doc = await newDoc(META.Title);
  doc.setAuthor(META.Author);
  doc.setSubject(META.Subject);
  doc.setKeywords(META.Keywords);
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const page = doc.addPage(LETTER);
  text(page, font, 'PAGE 1 OF metadata-xmp', 72, 700, 20);
  text(page, font, 'Info dictionary, XMP packet and one embedded file (attachment.txt).', 72, 670);

  const xmp = new TextEncoder().encode(xmpPacket());
  const metadata = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(name('Metadata'), doc.context.register(metadata));

  await doc.attach(new TextEncoder().encode('hello'), 'attachment.txt', {
    mimeType: 'text/plain',
    description: 'Plain-text attachment fixture',
    creationDate: FIXED_DATE,
    modificationDate: FIXED_DATE,
  });

  return {
    bytes: await save(doc, 'metadata-xmp.pdf'),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 1,
      pages: [
        { page: 1, mediaBox: box(0, 0, 612, 792), rotate: 0, markers: ['PAGE 1 OF metadata-xmp'] },
      ],
      info: {
        Title: META.Title,
        Author: META.Author,
        Subject: META.Subject,
        Keywords: META.Keywords.join(' '),
        Creator: CREATOR,
        Producer: PRODUCER,
        CreationDate: FIXED_DATE.toISOString(),
        ModDate: FIXED_DATE.toISOString(),
      },
      xmp: {
        'dc:title': META.Title,
        'dc:creator': META.Author,
        'dc:description': META.Subject,
        'pdf:Keywords': META.Keywords.join(' '),
        'pdf:Producer': PRODUCER,
        'xmp:CreatorTool': CREATOR,
        'xmp:CreateDate': FIXED_DATE_XMP,
        'xmp:ModifyDate': FIXED_DATE_XMP,
      },
      attachments: [{ name: 'attachment.txt', content: 'hello', mimeType: 'text/plain' }],
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 9. images
// ---------------------------------------------------------------------------

function rgbaImage(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const dx = (x - w / 2) / (w / 2);
      const dy = (y - h / 2) / (h / 2);
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      px[o] = Math.round((255 * x) / (w - 1));
      px[o + 1] = Math.round((255 * y) / (h - 1));
      px[o + 2] = 200;
      px[o + 3] = Math.round(255 * (1 - d)); // radial alpha falloff
    }
  }
  return px;
}

function rgbChecker(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const on = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0;
      px[o] = on ? 230 : 40;
      px[o + 1] = on ? 120 : 40;
      px[o + 2] = Math.round((255 * x) / (w - 1));
    }
  }
  return px;
}

/** Photo-like: sky gradient, a sun, rolling hills, a little seeded noise. */
function photoLike(w: number, h: number): Uint8Array {
  const random = seededRandom('images.pdf:jpeg-noise');
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const t = y / (h - 1);
      let r = 90 + 120 * t;
      let g = 140 + 80 * t;
      let b = 235 - 40 * t;
      const sun = Math.hypot(x - w * 0.72, y - h * 0.28);
      if (sun < h * 0.14) {
        r = 255;
        g = 220;
        b = 90;
      }
      const hill = h * 0.62 + Math.sin(x / 11) * h * 0.06 + Math.sin(x / 29) * h * 0.08;
      if (y > hill) {
        const shade = (y - hill) / (h - hill);
        r = 40 + 30 * shade;
        g = 120 - 40 * shade;
        b = 50;
      }
      const noise = (random() - 0.5) * 12;
      px[o] = Math.max(0, Math.min(255, Math.round(r + noise)));
      px[o + 1] = Math.max(0, Math.min(255, Math.round(g + noise)));
      px[o + 2] = Math.max(0, Math.min(255, Math.round(b + noise)));
    }
  }
  return px;
}

async function buildImages(): Promise<Built> {
  const doc = await newDoc('Images fixture');
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const alphaPng = await doc.embedPng(encodePng(160, 120, 4, rgbaImage(160, 120)));
  const opaquePng = await doc.embedPng(encodePng(128, 96, 3, rgbChecker(128, 96)));
  const jpeg = await doc.embedJpg(encodeJpeg(160, 120, photoLike(160, 120), 80));
  const specs = [
    { image: alphaPng, marker: 'PAGE 1 PNG WITH ALPHA (SMask)' },
    { image: opaquePng, marker: 'PAGE 2 PNG WITHOUT ALPHA' },
    { image: jpeg, marker: 'PAGE 3 BASELINE JPEG (DCTDecode)' },
  ];
  for (const spec of specs) {
    const page = doc.addPage(LETTER);
    // Striped background so transparency is visible.
    for (let i = 0; i < 12; i++) {
      page.drawRectangle({
        x: 72 + i * 40,
        y: 300,
        width: 20,
        height: 360,
        color: rgb(0.85, 0.85, 0.85),
      });
    }
    page.drawImage(spec.image, { x: 126, y: 330, width: 360, height: 270 });
    text(page, font, spec.marker, 72, 700, 18);
  }
  return {
    bytes: await save(doc, 'images.pdf'),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 3,
      pages: specs.map((spec, i) => ({
        page: i + 1,
        mediaBox: box(0, 0, 612, 792),
        rotate: 0,
        markers: [spec.marker],
      })),
      images: [
        { page: 1, filter: 'FlateDecode', width: 160, height: 120, smask: true },
        { page: 2, filter: 'FlateDecode', width: 128, height: 96, smask: false },
        { page: 3, filter: 'DCTDecode', width: 160, height: 120, smask: false },
      ],
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 10. cropbox
// ---------------------------------------------------------------------------

async function buildCropBox(): Promise<Built> {
  const doc = await newDoc('CropBox fixture');
  const font = doc.embedStandardFont(StandardFonts.Helvetica);

  const p1 = doc.addPage(LETTER);
  p1.setCropBox(72, 144, 468, 576); // [72 144 540 720]
  p1.drawRectangle({
    x: 72,
    y: 144,
    width: 468,
    height: 576,
    borderColor: rgb(0.6, 0.6, 0.6),
    borderWidth: 1,
  });
  text(p1, font, 'VISIBLE INSIDE CROPBOX PAGE 1', 100, 650, 16);
  text(p1, font, 'CROPPED MARKER PAGE 1 STARTS OUTSIDE THE CROPBOX', 20, 400, 16);
  text(p1, font, 'HIDDEN MARKER PAGE 1 ENTIRELY OUTSIDE', 72, 60, 16);

  const p2 = doc.addPage(LETTER);
  p2.setCropBox(150, 200, 300, 300); // [150 200 450 500]
  p2.setBleedBox(155, 205, 290, 290);
  p2.setTrimBox(160, 210, 280, 280);
  p2.drawRectangle({
    x: 150,
    y: 200,
    width: 300,
    height: 300,
    borderColor: rgb(0.6, 0.6, 0.6),
    borderWidth: 1,
  });
  text(p2, font, 'VISIBLE PAGE 2', 180, 450, 16);
  text(p2, font, 'CROPPED MARKER PAGE 2 CROSSES LEFT EDGE', 60, 350, 14);

  return {
    bytes: await save(doc, 'cropbox.pdf'),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 2,
      pages: [
        {
          page: 1,
          mediaBox: box(0, 0, 612, 792),
          cropBox: box(72, 144, 468, 576),
          rotate: 0,
          displayedSize: [468, 576],
          markers: [
            'VISIBLE INSIDE CROPBOX PAGE 1',
            'CROPPED MARKER PAGE 1 STARTS OUTSIDE THE CROPBOX',
            'HIDDEN MARKER PAGE 1 ENTIRELY OUTSIDE',
          ],
        },
        {
          page: 2,
          mediaBox: box(0, 0, 612, 792),
          cropBox: box(150, 200, 300, 300),
          bleedBox: box(155, 205, 290, 290),
          trimBox: box(160, 210, 280, 280),
          rotate: 0,
          displayedSize: [300, 300],
          markers: ['VISIBLE PAGE 2', 'CROPPED MARKER PAGE 2 CROSSES LEFT EDGE'],
        },
      ],
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 11. many-pages (nested page tree with inherited attributes)
// ---------------------------------------------------------------------------

const MANY = 400;
const PER_NODE = 20;

async function buildManyPages(): Promise<Built> {
  const doc = await newDoc('Many pages fixture');
  const ctx = doc.context;
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const pages: PDFPage[] = [];
  for (let i = 1; i <= MANY; i++) {
    const page = doc.addPage([200, 100]);
    setRawContent(doc, page, `BT /F1 40 Tf 20 30 Td (${i}) Tj ET`);
    pages.push(page);
  }

  // Rebuild the page tree: root /Pages -> 20 intermediate /Pages -> 20 leaves.
  // /MediaBox is inherited from the root, /Resources from the intermediate
  // nodes, and the last intermediate node carries an inherited /Rotate 90.
  const rootRef = doc.catalog.get(name('Pages')) as PDFRef;
  const root = ctx.lookup(rootRef, PDFDict);
  const resources = ctx.register(ctx.obj({ Font: { F1: font.ref }, ProcSet: ['PDF', 'Text'] }));
  const kids: PDFRef[] = [];
  for (let g = 0; g < MANY / PER_NODE; g++) {
    const leaves = pages.slice(g * PER_NODE, (g + 1) * PER_NODE);
    const node = ctx.obj({
      Type: 'Pages',
      Parent: rootRef,
      Kids: leaves.map((p) => p.ref),
      Count: leaves.length,
      Resources: resources,
    });
    if (g === MANY / PER_NODE - 1) node.set(name('Rotate'), ctx.obj(90));
    const nodeRef = ctx.register(node);
    for (const leaf of leaves) {
      leaf.node.set(name('Parent'), nodeRef);
      leaf.node.delete(name('MediaBox'));
      leaf.node.delete(name('Resources'));
    }
    kids.push(nodeRef);
  }
  root.set(name('Kids'), ctx.obj(kids));
  root.set(name('Count'), ctx.obj(MANY));
  root.set(name('MediaBox'), ctx.obj([0, 0, 200, 100]));

  const rotatedFrom = MANY - PER_NODE + 1;
  const sample = (n: number): PageExpectation => ({
    page: n,
    mediaBox: box(0, 0, 200, 100),
    rotate: n >= rotatedFrom ? 90 : 0,
    markers: [String(n)],
  });
  return {
    bytes: await save(doc, 'many-pages.pdf', { objectStreams: true }),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: MANY,
      pages: [1, 2, 200, rotatedFrom - 1, rotatedFrom, MANY].map(sample),
      pageRanges: [
        {
          first: 1,
          last: rotatedFrom - 1,
          mediaBox: box(0, 0, 200, 100),
          rotate: 0,
          inheritedFrom: 'MediaBox from root /Pages; Resources from intermediate /Pages',
        },
        {
          first: rotatedFrom,
          last: MANY,
          mediaBox: box(0, 0, 200, 100),
          rotate: 90,
          inheritedFrom:
            'MediaBox from root /Pages; Resources and Rotate 90 from intermediate /Pages',
        },
      ],
      xref: 'stream',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 12. broken-xref / truncated / garbage-prefix
// ---------------------------------------------------------------------------

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

function brokenXref(source: Uint8Array): Built {
  const s = latin1(source);
  const at = s.lastIndexOf('startxref');
  const match = /startxref\s+(\d+)/.exec(s.slice(at));
  if (!match?.[1]) throw new Error('startxref not found');
  const original = Number(match[1]);
  const altered = original - 100; // in range, but not at the "xref" keyword
  const out =
    s.slice(0, at) + s.slice(at).replace(`startxref\n${original}`, `startxref\n${altered}`);
  if (out === s) throw new Error('startxref rewrite failed');
  return {
    bytes: new Uint8Array(Buffer.from(out, 'latin1')),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 3,
      damage: {
        kind: 'wrong startxref offset',
        originalStartxref: original,
        alteredStartxref: altered,
      },
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

function truncated(source: Uint8Array): Built {
  return {
    bytes: source.slice(0, source.length - 300),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 3,
      damage: { kind: 'last 300 bytes removed', originalBytes: source.length, removedBytes: 300 },
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

function garbagePrefix(source: Uint8Array): Built {
  const random = seededRandom('garbage-prefix.pdf');
  const junk = new Uint8Array(1024);
  for (let i = 0; i < junk.length; i++) {
    const byte = Math.floor(random() * 256);
    junk[i] = byte === 0x25 ? 0x2a : byte; // no '%' so no stray %PDF / %%EOF
  }
  const out = new Uint8Array(junk.length + source.length);
  out.set(junk);
  out.set(source, junk.length);
  return {
    bytes: out,
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 3,
      damage: { kind: 'junk bytes prepended before %PDF', prefixBytes: 1024, headerOffset: 1024 },
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 14. annotations
// ---------------------------------------------------------------------------

async function buildAnnotations(): Promise<Built> {
  const doc = await newDoc('Annotations fixture');
  const ctx = doc.context;
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const p1 = doc.addPage(LETTER);
  const p2 = doc.addPage(LETTER);
  text(p1, font, 'PAGE 1 OF annotations', 72, 740, 10);
  text(p2, font, 'PAGE 2 OF annotations', 72, 740, 10);
  const date = PDFString.fromDate(FIXED_DATE);
  const markup = (nm: string, page: PDFPage, extra: Record<string, unknown>) =>
    ctx.obj({
      Type: 'Annot',
      P: page.ref,
      NM: str(nm),
      M: date,
      CreationDate: date,
      T: str('Fixture Author'),
      ...(extra as Record<string, PDFObject>),
    });
  const form = (bbox: number[], content: string, resources?: PDFDict) =>
    ctx.register(
      ctx.stream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: bbox,
        Matrix: [1, 0, 0, 1, 0, 0],
        ...(resources ? { Resources: resources } : {}),
      }),
    );

  // Highlight over a line of text. QuadPoints use the de-facto (Acrobat, pdf.js,
  // PDFium) order: upper-left, upper-right, lower-left, lower-right, so that
  // (x1,y1)-(x2,y2) is the top edge the text is oriented to (ISO 32000-2 Table 182).
  const hlText = 'This sentence carries a Highlight annotation.';
  const size = 16;
  const baseline = 680;
  text(p1, font, hlText, 72, baseline, size);
  const x1 = 72;
  const x2 = round2(72 + font.widthOfTextAtSize(hlText, size));
  const yTop = baseline + 15;
  const yBottom = baseline - 5;
  const quad = [x1, yTop, x2, yTop, x1, yBottom, x2, yBottom];
  const hlRect = [x1, yBottom, x2, yTop];
  const gsMultiply = ctx.obj({
    ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } },
  });
  const highlight = ctx.register(
    markup('fixture-annot-highlight-1', p1, {
      Subtype: 'Highlight',
      Rect: hlRect,
      QuadPoints: quad,
      C: [1, 0.92, 0.23],
      F: 4,
      Contents: str('Highlighted sentence'),
      AP: {
        N: form(
          hlRect,
          `/GS0 gs 1 0.92 0.23 rg ${x1} ${yBottom} ${round2(x2 - x1)} ${yTop - yBottom} re f`,
          gsMultiply,
        ),
      },
    }),
  );

  // Square with border and interior colour. /Rect encloses the full stroke.
  const sq = { x: 72, y: 420, w: 200, h: 150, bw: 2 };
  text(p1, font, 'Square annotation below (blue border, light blue fill)', 72, 590, 12);
  const square = ctx.register(
    markup('fixture-annot-square-1', p1, {
      Subtype: 'Square',
      Rect: [sq.x, sq.y, sq.x + sq.w, sq.y + sq.h],
      BS: { Type: 'Border', W: sq.bw, S: 'S' },
      C: [0, 0, 1],
      IC: [0.85, 0.9, 1],
      F: 4,
      Contents: str('Square with border and interior colour'),
      AP: {
        N: form(
          [0, 0, sq.w, sq.h],
          `0 0 1 RG 0.85 0.9 1 rg ${sq.bw} w ${sq.bw / 2} ${sq.bw / 2} ${sq.w - sq.bw} ${sq.h - sq.bw} re B`,
        ),
      },
    }),
  );
  p1.node.set(name('Annots'), ctx.obj([highlight, square]));

  // Text (sticky note) + Popup on page 2.
  text(
    p2,
    font,
    'Sticky note (Text annotation with Popup) to the left of this line.',
    100,
    686,
    12,
  );
  const noteRef = ctx.nextRef();
  const popupRef = ctx.nextRef();
  ctx.assign(
    noteRef,
    markup('fixture-annot-text-1', p2, {
      Subtype: 'Text',
      Rect: [72, 680, 92, 700],
      Name: 'Comment',
      Open: false,
      C: [1, 0.85, 0],
      F: 28, // Print | NoZoom | NoRotate
      Contents: str('Sticky note text on page 2'),
      Subj: str('Note'),
      Popup: popupRef,
      AP: {
        N: form(
          [0, 0, 20, 20],
          '1 0.85 0 rg 0 0 0 RG 0.5 w 0.25 0.25 19.5 19.5 re B 4 14 m 16 14 l 4 10 m 16 10 l 4 6 m 12 6 l S',
        ),
      },
    }),
  );
  ctx.assign(
    popupRef,
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Popup',
      P: p2.ref,
      NM: str('fixture-annot-popup-1'),
      M: date,
      Parent: noteRef,
      Rect: [100, 560, 300, 660],
      Open: false,
      F: 28,
    }),
  );

  // Ink with two strokes.
  text(p2, font, 'Ink annotation (two strokes) below', 72, 520, 12);
  const strokes = [
    [80, 400, 120, 460, 160, 400, 200, 460, 240, 400],
    [80, 360, 140, 330, 200, 340, 260, 370, 300, 350],
  ];
  const inkWidth = 3;
  const xs = strokes.flat().filter((_, i) => i % 2 === 0);
  const ys = strokes.flat().filter((_, i) => i % 2 === 1);
  const pad = inkWidth / 2 + 1;
  const inkRect = [
    Math.min(...xs) - pad,
    Math.min(...ys) - pad,
    Math.max(...xs) + pad,
    Math.max(...ys) + pad,
  ];
  const inkPath = strokes
    .map((s) =>
      s
        .reduce<string[]>((ops, v, i) => {
          if (i % 2 === 1) ops.push(`${s[i - 1]} ${v} ${i === 1 ? 'm' : 'l'}`);
          return ops;
        }, [])
        .join(' '),
    )
    .join(' ');
  const ink = ctx.register(
    markup('fixture-annot-ink-1', p2, {
      Subtype: 'Ink',
      Rect: inkRect,
      InkList: strokes,
      BS: { Type: 'Border', W: inkWidth, S: 'S' },
      C: [1, 0, 0],
      F: 4,
      Contents: str('Freehand ink'),
      AP: { N: form(inkRect, `1 0 0 RG ${inkWidth} w 1 J 1 j ${inkPath} S`) },
    }),
  );
  p2.node.set(name('Annots'), ctx.obj([noteRef, popupRef, ink]));

  return {
    bytes: await save(doc, 'annotations.pdf'),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 2,
      pages: [1, 2].map((n) => ({
        page: n,
        mediaBox: box(0, 0, 612, 792),
        rotate: 0,
        markers: [`PAGE ${n} OF annotations`],
      })),
      annotations: [
        {
          page: 1,
          subtype: 'Highlight',
          nm: 'fixture-annot-highlight-1',
          hasAppearance: true,
          flags: 4,
          quadPoints: quad,
          blendMode: 'Multiply',
        },
        { page: 1, subtype: 'Square', nm: 'fixture-annot-square-1', hasAppearance: true, flags: 4 },
        { page: 2, subtype: 'Text', nm: 'fixture-annot-text-1', hasAppearance: true, flags: 28 },
        {
          page: 2,
          subtype: 'Popup',
          nm: 'fixture-annot-popup-1',
          hasAppearance: false,
          flags: 28,
          popupOf: 'fixture-annot-text-1',
        },
        {
          page: 2,
          subtype: 'Ink',
          nm: 'fixture-annot-ink-1',
          hasAppearance: true,
          flags: 4,
          inkStrokes: 2,
        },
      ],
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 15. tagged
// ---------------------------------------------------------------------------

async function buildTagged(): Promise<Built> {
  const doc = await newDoc('Tagged PDF fixture');
  const ctx = doc.context;
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  doc.setLanguage('en-US');
  doc.catalog.set(name('MarkInfo'), ctx.obj({ Marked: true }));
  doc.catalog.set(name('ViewerPreferences'), ctx.obj({ DisplayDocTitle: true }));

  const rootRef = ctx.nextRef();
  const documentRef = ctx.nextRef();
  const paragraphRefs: PDFRef[] = [];
  const pages: PDFPage[] = [];
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage(LETTER);
    pages.push(page);
    page.node.set(name('Resources'), ctx.obj({ Font: { F1: font.ref } }));
    page.node.set(name('StructParents'), ctx.obj(i));
    setRawContent(
      doc,
      page,
      [
        '/P <</MCID 0>> BDC',
        `BT /F1 14 Tf 72 700 Td (Tagged paragraph on page ${i + 1} of tagged.) Tj ET`,
        'EMC',
        '/Artifact <</Type /Pagination /Subtype /Footer>> BDC',
        `BT /F1 9 Tf 72 40 Td (PAGE ${i + 1} OF tagged) Tj ET`,
        'EMC',
      ].join('\n'),
    );
    const pRef = ctx.register(
      ctx.obj({ Type: 'StructElem', S: 'P', P: documentRef, Pg: page.ref, K: 0 }),
    );
    paragraphRefs.push(pRef);
  }
  ctx.assign(
    documentRef,
    ctx.obj({ Type: 'StructElem', S: 'Document', P: rootRef, K: paragraphRefs }),
  );
  ctx.assign(
    rootRef,
    ctx.obj({
      Type: 'StructTreeRoot',
      K: documentRef,
      ParentTree: ctx.register(
        ctx.obj({ Nums: [0, [at(paragraphRefs, 0)], 1, [at(paragraphRefs, 1)]] }),
      ),
      ParentTreeNextKey: 2,
    }),
  );
  doc.catalog.set(name('StructTreeRoot'), rootRef);

  return {
    bytes: await save(doc, 'tagged.pdf'),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 2,
      pages: pages.map((_, i) => ({
        page: i + 1,
        mediaBox: box(0, 0, 612, 792),
        rotate: 0,
        markers: [`Tagged paragraph on page ${i + 1} of tagged.`, `PAGE ${i + 1} OF tagged`],
      })),
      tagged: {
        marked: true,
        structTypes: ['Document', 'P', 'P'],
        structParents: [0, 1],
        mcids: [0, 0],
      },
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture table
// ---------------------------------------------------------------------------

const PW = { user: 'user', owner: 'owner' };
const need = (built: Map<string, Uint8Array>, file: string): Uint8Array => {
  const bytes = built.get(file);
  if (!bytes) throw new Error(`${file} must be generated first`);
  return bytes;
};

const FIXTURES: FixtureDef[] = [
  {
    file: 'simple-text.pdf',
    tags: ['text', 'letter', 'baseline'],
    summary: '3 US Letter pages, Helvetica, unique marker "PAGE n OF simple-text" per page.',
    behavior:
      'Baseline for every structural op. Text extraction yields each marker on its own page; split/extract/reorder must keep marker-to-page mapping.',
    howGenerated: 'pdf-lib drawText',
    build: buildSimpleText,
  },
  {
    file: 'rotated-pages.pdf',
    tags: ['rotation', 'a4'],
    summary: '4 A4 pages with /Rotate 0, 90, 180, 270.',
    behavior:
      'Thumbnails and render must honour /Rotate; rotate ops must change /Rotate (never rewrite content); watermarks/page numbers/annotations must be placed in unrotated user space so they appear upright.',
    howGenerated: 'pdf-lib setRotation',
    build: buildRotatedPages,
  },
  {
    file: 'mixed-sizes.pdf',
    tags: ['page-size', 'rotation', 'a4', 'letter'],
    summary:
      'A4 portrait, Letter portrait, A4 landscape via /Rotate 90, A4 landscape via swapped MediaBox, 200x200 pt square.',
    behavior:
      "Pages 3 and 4 both display as landscape A4 but differ structurally; merge/N-up/resize must keep each page's own MediaBox and /Rotate.",
    howGenerated: 'pdf-lib addPage(size) + setRotation',
    build: buildMixedSizes,
  },
  {
    file: 'outline-named-dests.pdf',
    tags: ['outline', 'named-dests', 'links', 'text-string-utf16'],
    summary:
      '6 pages; nested outline (3 top-level, "Chapter 2" has 2 children, "2.2 Results" collapsed with 1 child); explicit /XYZ, /Fit, /FitH dests; named dests in both /Names/Dests and catalog /Dests; GoTo link to page 4, /Dest link to named dest, URI link.',
    behavior:
      'Merge/reorder must keep outline titles "Chapter 1: Introduction", "Chapter 2 – Methods", "2.1 Setup", "2.2 Results", "2.2.1 Details", "Appendix" with the same open/closed state, remap explicit and named dests to the new page objects, rewrite the page-2 GoTo link to the new page-4 object, and drop outline items/links whose target page was removed. Named dests exist in both the name tree and the catalog /Dests dict (pypdf 6 only reports the latter).',
    howGenerated: 'pdf-lib low-level dicts (outline tree, name tree, Link annots)',
    build: buildOutline,
  },
  {
    file: 'page-labels.pdf',
    tags: ['page-labels'],
    summary: '8 pages labelled i, ii, iii, 1, 2, 3, A-1, A-2 via /PageLabels number tree.',
    behavior:
      'UI shows labels next to physical numbers; every structural op must rebuild /PageLabels from per-page labels (deleting page 2 gives i, ii, 1, 2, 3, A-1, A-2). Label dicts carry the optional /Type /PageLabel; PyMuPDF 1.28 Page.get_label() misreads it as a "/P" prefix ("ageLabeli").',
    howGenerated: 'pdf-lib low-level /PageLabels',
    build: buildPageLabels,
  },
  {
    file: 'forms-a.pdf',
    tags: ['acroform', 'need-appearances', 'field-collision'],
    summary:
      '2 pages; fields name, agree, choice (radio optionA/optionB), country (dropdown), address.city, only_in_a. /NeedAppearances true; text/choice widgets have no /AP.',
    behavior:
      'Filling must regenerate appearances (or keep NeedAppearances consistent). Merging with forms-b must not silently unify name/agree/choice/country/address.city (values differ): wrap per document or rename with a namespace; only_in_a survives unchanged. The radio group uses /Opt (pdf-lib style): widget on-states are /0 and /1 and /Opt maps them to optionA/optionB, so engines that ignore /Opt report "0"/"1".',
    howGenerated: 'pdf-lib PDFForm, /AP stripped, NeedAppearances set',
    build: () => buildForms('a'),
  },
  {
    file: 'forms-b.pdf',
    tags: ['acroform', 'appearances', 'field-collision'],
    summary:
      'Same field names as forms-a with different values, plus only_in_b; all widgets carry generated /AP.',
    behavior:
      'Renders filled values without NeedAppearances. Counterpart of forms-a for collision tests (name = "Bob Example" vs "Alice Example").',
    howGenerated: 'pdf-lib PDFForm with updateFieldAppearances',
    build: () => buildForms('b'),
  },
  {
    file: 'encrypted-rc4-40.pdf',
    tags: ['encryption', 'rc4', 'weak-crypto'],
    summary:
      'simple-text encrypted with RC4 40-bit (V1/R2). Print allowed; modify and copy disallowed.',
    behavior:
      'Password prompt; "user" opens with restrictions, "owner" opens fully; wrong password rejected. Never save with ignoreEncryption. Decrypted content equals simple-text.',
    howGenerated:
      'pdf-lib encrypt({algorithm: "RC4-40"}) + string-encryption workaround, seeded RNG',
    passwords: PW,
    derivedFrom: 'simple-text.pdf',
    build: async (b) => buildEncrypted(need(b, 'simple-text.pdf'), 'RC4-40', 'user', 'owner'),
  },
  {
    file: 'encrypted-rc4-128.pdf',
    tags: ['encryption', 'rc4', 'weak-crypto'],
    summary:
      'simple-text encrypted with RC4 128-bit (V2/R3). Print allowed; modify and copy disallowed.',
    behavior: 'As encrypted-rc4-40 (R3 permission bits).',
    howGenerated:
      'pdf-lib encrypt({algorithm: "RC4-128"}) + string-encryption workaround, seeded RNG',
    passwords: PW,
    derivedFrom: 'simple-text.pdf',
    build: async (b) => buildEncrypted(need(b, 'simple-text.pdf'), 'RC4-128', 'user', 'owner'),
  },
  {
    file: 'encrypted-aes-128.pdf',
    tags: ['encryption', 'aes'],
    summary:
      'simple-text encrypted with AES-128 (V4/R4, AESV2 crypt filter). Print allowed; modify and copy disallowed.',
    behavior: 'As encrypted-rc4-40.',
    howGenerated:
      'pdf-lib encrypt({algorithm: "AES-128"}) + string-encryption workaround, seeded RNG',
    passwords: PW,
    derivedFrom: 'simple-text.pdf',
    build: async (b) => buildEncrypted(need(b, 'simple-text.pdf'), 'AES-128', 'user', 'owner'),
  },
  {
    file: 'encrypted-aes-256.pdf',
    tags: ['encryption', 'aes', 'pdf-2.0-security'],
    summary:
      'simple-text encrypted with AES-256 (V5/R6, AESV3). Print allowed; modify and copy disallowed.',
    behavior: 'As encrypted-rc4-40; exercises the R6 SHA-2 hash loop.',
    howGenerated: 'pdf-lib encrypt() default + string-encryption workaround, seeded RNG',
    passwords: PW,
    derivedFrom: 'simple-text.pdf',
    build: async (b) => buildEncrypted(need(b, 'simple-text.pdf'), 'AES-256', 'user', 'owner'),
  },
  {
    file: 'encrypted-owner-only-aes-256.pdf',
    tags: ['encryption', 'aes', 'owner-password-only'],
    summary: 'simple-text, AES-256, empty user password, owner password "owner"; print only.',
    behavior:
      'Opens without a prompt but reports restricted permissions; removing restrictions requires the owner password (product policy).',
    howGenerated: 'pdf-lib encrypt({userPassword: ""}) + string-encryption workaround, seeded RNG',
    passwords: { user: '', owner: 'owner' },
    derivedFrom: 'simple-text.pdf',
    build: async (b) => buildEncrypted(need(b, 'simple-text.pdf'), 'AES-256', '', 'owner'),
  },
  {
    file: 'metadata-xmp.pdf',
    tags: ['metadata', 'xmp', 'attachments'],
    summary:
      'Info dict (Title, Author, Subject, Keywords, Creator, Producer, dates), matching XMP packet, embedded file attachment.txt ("hello").',
    behavior:
      'Metadata editor shows the same values from Info and XMP; edits and "scrub" must update/clear both together and regenerate /ID; attachment lists and extracts as 5 bytes "hello"; redaction/scrub must offer to drop it.',
    howGenerated: 'pdf-lib setters + raw /Metadata stream + attach()',
    build: buildMetadata,
  },
  {
    file: 'images.pdf',
    tags: ['images', 'png', 'jpeg', 'smask'],
    summary:
      'Page 1 PNG with alpha (FlateDecode + /SMask), page 2 opaque PNG (FlateDecode), page 3 baseline JPEG (DCTDecode) from an in-repo encoder.',
    behavior:
      'Compression must keep the /SMask, must not re-encode the JPEG at a larger size, and must report the actual byte delta. Image extraction returns 3 images.',
    howGenerated: 'In-tool PNG/JPEG encoders + pdf-lib embedPng/embedJpg',
    build: buildImages,
  },
  {
    file: 'cropbox.pdf',
    tags: ['cropbox', 'page-boxes'],
    summary:
      '2 pages with CropBox smaller than and offset inside MediaBox; page 2 also has BleedBox and TrimBox. Markers partly and fully outside the CropBox.',
    behavior:
      'Render/thumbnail show only the CropBox. "Crop" must set /CropBox, not delete content: the hidden marker stays in the content stream (MuPDF text extraction clips it to the CropBox, so check raw content too) and redaction must still treat it as present. Watermarks/page numbers must be positioned relative to the CropBox.',
    howGenerated: 'pdf-lib setCropBox/setBleedBox/setTrimBox',
    build: buildCropBox,
  },
  {
    file: 'many-pages.pdf',
    tags: ['performance', 'page-tree', 'inheritance', 'object-streams'],
    summary:
      '400 pages of 200x100 pt, each showing its number. Two-level page tree (20 x 20): MediaBox inherited from root /Pages, Resources from intermediate nodes, /Rotate 90 inherited on pages 381-400. Xref stream + object streams.',
    behavior:
      'Virtualised thumbnail grid; split/extract must materialise inherited MediaBox/Resources/Rotate onto copied pages (pages 381-400 stay rotated 90).',
    howGenerated: 'pdf-lib pages + low-level page-tree rebuild, useObjectStreams',
    build: buildManyPages,
  },
  {
    file: 'broken-xref.pdf',
    tags: ['repair', 'damaged'],
    summary:
      'simple-text with the startxref offset changed to point 100 bytes before the real xref table.',
    behavior:
      'Must open via xref reconstruction (3 pages), tell the user the file was repaired, and never save incrementally onto it.',
    howGenerated: 'Byte surgery on simple-text.pdf',
    derivedFrom: 'simple-text.pdf',
    build: (b) => Promise.resolve(brokenXref(need(b, 'simple-text.pdf'))),
  },
  {
    file: 'truncated.pdf',
    tags: ['repair', 'damaged'],
    summary:
      'simple-text with the last 300 bytes removed (xref table tail, trailer, startxref, %%EOF gone).',
    behavior:
      'Must open via object scan (3 pages) with a "repaired" notice, or fail with a clear error; never crash.',
    howGenerated: 'Byte surgery on simple-text.pdf',
    derivedFrom: 'simple-text.pdf',
    build: (b) => Promise.resolve(truncated(need(b, 'simple-text.pdf'))),
  },
  {
    file: 'garbage-prefix.pdf',
    tags: ['repair', 'damaged'],
    summary:
      '1024 junk bytes before %PDF (header at offset 1024, just outside the 1024-byte window readers usually scan), so every xref offset is off by 1024.',
    behavior:
      'Must open (3 pages) by locating the header and rebuilding/adjusting offsets; saving writes a clean file starting with %PDF.',
    howGenerated: 'Byte surgery on simple-text.pdf (seeded junk)',
    derivedFrom: 'simple-text.pdf',
    build: (b) => Promise.resolve(garbagePrefix(need(b, 'simple-text.pdf'))),
  },
  {
    file: 'xfa-stub.pdf',
    tags: ['xfa', 'acroform'],
    summary:
      'forms-a content plus /AcroForm /XFA pointing to a minimal XDP stream (static/foreground form, no /NeedsRendering).',
    behavior:
      'Detected as XFA; UI warns before editing; AcroForm fields remain fillable; if saving strips /XFA it must say so. pdf-lib getForm() deletes XFA unless preserveXFA: true. /XFA is the single-stream form (pypdf 6 only reads the packet-array form), so detection must accept both.',
    howGenerated: 'forms-a builder + raw XDP stream',
    build: buildXfaStub,
  },
  {
    file: 'annotations.pdf',
    tags: ['annotations', 'appearance-streams'],
    summary:
      'Page 1: Highlight (QuadPoints, /AP with Multiply ExtGState) and Square (border + interior colour, /AP). Page 2: Text note with Popup, Ink with 2 strokes. All with /P, /NM, /F.',
    behavior:
      'All render in pdf.js/PDFium/MuPDF from their /AP; flatten keeps their look; merge/rotate keep them anchored in unrotated user space; the Popup stays linked to its parent (/Parent, /Popup) after copy.',
    howGenerated: 'pdf-lib low-level annotation dicts and Form XObjects',
    build: buildAnnotations,
  },
  {
    file: 'tagged.pdf',
    tags: ['tagged', 'structure-tree', 'accessibility'],
    summary:
      '2 pages; /MarkInfo /Marked true, /StructTreeRoot -> Document -> P per page (MCID 0), /ParentTree, /StructParents 0 and 1, footer marked as /Artifact.',
    behavior:
      'Detected as tagged. A merge or page removal that cannot rebuild the structure tree must remove /StructTreeRoot and /MarkInfo (and page /StructParents) and tell the user, never leave dangling MCIDs.',
    howGenerated: 'pdf-lib low-level structure tree + raw marked content',
    build: buildTagged,
  },
];

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function renderReadme(entries: ManifestEntry[], defs: FixtureDef[]): string {
  const byFile = new Map(defs.map((d) => [d.file, d]));
  const total = entries.reduce((n, e) => n + e.bytes, 0);
  const rows = entries.map((e) => {
    const def = byFile.get(e.file);
    const pw = e.passwords
      ? `user \`${e.passwords.user || '(empty)'}\`, owner \`${e.passwords.owner}\``
      : '-';
    return `| \`${e.file}\` | ${formatSize(e.bytes)} | ${e.summary.replaceAll('|', '\\|')} | ${pw} | ${def?.howGenerated ?? ''} |`;
  });
  const behavior = entries.map((e) => `- **\`${e.file}\`**: ${byFile.get(e.file)?.behavior ?? ''}`);
  return `# PDF test corpus

Generated by \`tools/fixtures/generate.ts\`; do not edit the PDFs by hand. Every
file is built from scratch by that script (no third-party documents, fonts or
images), so the corpus is redistributable under the repository licence.

\`\`\`sh
pnpm --filter @pdf-editor/fixtures-tool generate          # rewrite fixtures, README.md, manifest.json
pnpm --filter @pdf-editor/fixtures-tool generate --check  # rebuild in memory and compare with disk
pnpm --filter @pdf-editor/fixtures-tool verify            # re-parse every file and check manifest.json
\`\`\`

- **Machine-readable expectations** (page boxes, rotation, labels, outline, named
  destinations, links, field names/values, encryption parameters, metadata,
  annotations, structure tree) live in \`manifest.json\`, with a sha256 per file.
- **Determinism:** all dates are ${FIXED_DATE.toISOString()}; the trailer /ID is the
  MD5 of the file name; while a fixture is built, \`Math.random\` and
  \`crypto.getRandomValues\` are replaced by a PRNG seeded from the file name, so
  the encryption keys, salts, IVs and /ID of the encrypted fixtures are
  reproducible too (and therefore not secret: test data only). Re-running the
  generator with the same \`@cantoo/pdf-lib\` version (${PDF_LIB_VERSION}) and Node
  zlib produces byte-identical files.
- **Total size:** ${formatSize(total)} across ${entries.length} files.
- **Not covered here** (need real-world files, to be added separately): Type3
  fonts, CCITT/JBIG2/JPX scans, signed PDFs, incremental-update history,
  optional content (layers), public-key encryption, dynamic XFA.

## Library behaviour found while building the corpus

- \`@cantoo/pdf-lib\` ${PDF_LIB_VERSION} \`encrypt()\` encrypts stream data only and
  writes every string (Info dict, annotation /Contents, field values, ...) in
  plaintext, violating ISO 32000-2 §7.6.2: RC4 readers then decode the Info dict to
  garbage and AES readers either fail or fall back to the raw bytes. The generator
  encrypts all strings itself before saving (\`encryptStrings\` in generate.ts).
  **Do not use pdf-lib's \`encrypt()\` for product exports without the same fix.**
- pdf-lib loads \`broken-xref.pdf\`, \`truncated.pdf\` and \`garbage-prefix.pdf\`
  without error or warning (it scans objects and ignores the xref), so it cannot
  tell the UI that a file was repaired; MuPDF reports \`is_repaired\` for all three.
- pdf-lib \`getForm()\` deletes /XFA unless the document is loaded with
  \`preserveXFA: true\`.
- Cross-checks with PyMuPDF 1.28 / pypdf 6: PyMuPDF \`Page.get_label()\` misreads
  \`/Type /PageLabel\` as a prefix; pypdf ignores the /Names/Dests tree when a
  catalog /Dests dict exists and only reads array-form /XFA.

## Files

| File | Size | What it exercises | Passwords | How generated |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

## Expected behaviour

${behavior.join('\n')}
`;
}

/**
 * Formats manifest.json with the repository's Biome so `pnpm format:check`
 * stays green; falls back to plain JSON.stringify output if Biome is missing.
 */
function formatJson(json: string): string {
  const biome = join(REPO_ROOT, 'node_modules', '.bin', 'biome');
  if (!existsSync(biome)) return json;
  try {
    return execFileSync(
      biome,
      ['format', `--stdin-file-path=${join(FIXTURES_DIR, 'manifest.json')}`],
      {
        cwd: REPO_ROOT,
        input: json,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
  } catch {
    return json;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const built = new Map<string, Uint8Array>();
  const entries: ManifestEntry[] = [];

  for (const def of FIXTURES) {
    const result = await withDeterministicRandom(def.file, () => def.build(built));
    built.set(def.file, result.bytes);
    const entry: ManifestEntry = {
      file: def.file,
      bytes: result.bytes.length,
      sha256: sha256(result.bytes),
      pageCount: result.expect.pageCount,
      tags: def.tags,
      summary: def.summary,
      expect: result.expect,
    };
    if (def.derivedFrom) entry.derivedFrom = def.derivedFrom;
    if (def.passwords) entry.passwords = def.passwords;
    entries.push(entry);
  }

  const total = entries.reduce((n, e) => n + e.bytes, 0);
  if (total > MAX_CORPUS_BYTES) throw new Error(`Corpus is ${total} bytes, over the 6 MB budget`);

  const manifest: Manifest = {
    $comment:
      'Generated by tools/fixtures/generate.ts. Page numbers are 1-based. Boxes are [x, y, width, height].',
    generator: 'tools/fixtures/generate.ts',
    pdfLib: `@cantoo/pdf-lib@${PDF_LIB_VERSION}`,
    fixedDate: FIXED_DATE.toISOString(),
    fixtures: entries,
  };
  const outputs = new Map<string, Uint8Array | string>();
  for (const [file, bytes] of built) outputs.set(file, bytes);
  outputs.set('manifest.json', formatJson(`${JSON.stringify(manifest, null, 2)}\n`));
  outputs.set('README.md', renderReadme(entries, FIXTURES));

  if (check) {
    const mismatched: string[] = [];
    for (const [file, content] of outputs) {
      const path = join(FIXTURES_DIR, file);
      const expected = typeof content === 'string' ? Buffer.from(content) : content;
      if (!existsSync(path) || sha256(readFileSync(path)) !== sha256(expected))
        mismatched.push(file);
    }
    if (mismatched.length) {
      console.error(`Not reproducible / out of date: ${mismatched.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`All ${outputs.size} outputs are byte-identical to test/fixtures/.`);
    return;
  }

  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [file, content] of outputs) writeFileSync(join(FIXTURES_DIR, file), content);
  for (const e of entries)
    console.log(`${e.file.padEnd(36)} ${String(e.bytes).padStart(8)} B  ${e.sha256.slice(0, 12)}`);
  console.log(`${entries.length} fixtures, ${formatSize(total)} total -> ${FIXTURES_DIR}`);
}

await main();
