/**
 * The batch runner against the real engines (PDFium worker, assembler worker, compressor)
 * on corpus files: built-in recipes produce verified outputs, notices are collected, an
 * encrypted input asks its password once, a failing file never stops the batch, cancel
 * stops between files, continuous Bates numbers run across files, the output password
 * never reaches the report, and Markdown / text outputs come from the analysis worker with
 * the conversion's honesty notes.
 */
import {
  assertNoSecrets,
  BUILT_IN_RECIPES,
  RECIPE_FORMAT,
  RECIPE_VERSION,
  type Recipe,
  type RecipeRunPlan,
  planRecipeRun,
  type SourceId,
  sourceId,
} from '@pdf-editor/document-model';
import type { PdfRenderer } from '@pdf-editor/engine';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';

import encryptedUrl from '../../../../test/fixtures/encrypted-aes-128.pdf?url';
import formsUrl from '../../../../test/fixtures/forms-a.pdf?url';
import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import manifest from '../../../../test/fixtures/manifest.json';
import markdownUrl from '../../../../test/fixtures/markdown-source.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import truncatedUrl from '../../../../test/fixtures/truncated.pdf?url';
import { fixtureFile, pngBlob } from '../../test/store-harness';
import { convertWorkspaceDocument } from '../convert/convert-run';
import { getAnalysisWorkers, getEngineService } from '../engine/engine-service';
import { appBatchEngine } from './private-source';
import {
  type BatchFileState,
  type BatchRunResult,
  defaultBatchDependencies,
  runRecipe,
} from './runner';

const golden = (
  manifest.fixtures.find((f) => f.file === 'markdown-source.pdf')?.expect as unknown as {
    markdown: { golden: string };
  }
).markdown.golden;

afterAll(() => getAnalysisWorkers().terminate());

function builtIn(id: string): Recipe {
  const found = BUILT_IN_RECIPES.find((b) => b.id === id);
  if (!found) throw new Error(`no built-in ${id}`);
  return found.recipe;
}

function recipe(name: string, steps: Recipe['steps']): Recipe {
  return { format: RECIPE_FORMAT, version: RECIPE_VERSION, name, steps };
}

function planFor(r: Recipe, files: readonly File[]): RecipeRunPlan {
  return planRecipeRun(
    r,
    files.map((f) => ({ name: f.name, size: f.size })),
  );
}

let scratch = 0;

/** Text of `pageIndex` of `bytes` through PDFium (the app's worker), then closes it. */
async function pageText(bytes: ArrayBuffer, pageIndex: number, password?: string): Promise<string> {
  const engine = await appBatchEngine();
  const renderer = (await getEngineService().editor()) as unknown as Pick<
    PdfRenderer,
    'getPageText'
  >;
  const id: SourceId = sourceId(`test-scratch-${++scratch}`);
  await engine.open(id, bytes.slice(0), password === undefined ? {} : { password });
  try {
    const runs = await renderer.getPageText(id, pageIndex);
    return runs.map((r) => r.text).join(' ');
  } finally {
    await engine.close(id);
  }
}

/** The entries of a ZIP (stored or deflated, sizes in the local headers), by path. */
async function unzip(bytes: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(new Uint8Array(bytes, offset + 30, nameLength));
    const start = offset + 30 + nameLength + extraLength;
    const data = new Uint8Array(bytes.slice(start, start + size));
    entries.set(
      name,
      method === 0
        ? data
        : new Uint8Array(
            await new Response(
              new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
            ).arrayBuffer(),
          ),
    );
    offset = start + size;
  }
  return entries;
}

async function outputBytes(result: BatchRunResult, index: number): Promise<ArrayBuffer> {
  const output = result.outputs.find((o) => o.index === index);
  if (!output) throw new Error(`no output ${index}`);
  return output.entry.data.arrayBuffer();
}

describe('built-in recipes over the corpus', () => {
  it('numbers the pages of every file, asks the encrypted one its password once, and verifies', async () => {
    const files = [
      await fixtureFile(simpleUrl, 'simple-text.pdf'),
      await fixtureFile(formsUrl, 'forms-a.pdf'),
      await fixtureFile(imagesUrl, 'images.pdf'),
      await fixtureFile(encryptedUrl, 'encrypted-aes-128.pdf'),
    ];
    const plan = planFor(builtIn('number-pages'), files);
    expect(plan.concurrency).toBe(2);
    const asked: { fileName: string; incorrect: boolean }[] = [];
    const states: BatchFileState[] = [];
    const result = await runRecipe(plan, files, {
      askPassword: (request) => {
        asked.push({ ...request });
        return Promise.resolve('user');
      },
      onFile: (state) => states.push(state),
    });

    expect(asked).toEqual([{ fileName: 'encrypted-aes-128.pdf', incorrect: false }]);
    const { report } = result;
    expect(report.totals).toMatchObject({ files: 4, failed: 0, skipped: 0 });
    expect(report.cancelled).toBe(false);
    expect(result.outputs.map((o) => o.name)).toEqual([
      'simple-text-Number pages.pdf',
      'forms-a-Number pages.pdf',
      'images-Number pages.pdf',
      'encrypted-aes-128-Number pages.pdf',
    ]);
    // Every file went through the steps and the export's verification.
    for (const file of report.files) {
      expect(['done', 'done-with-notes']).toContain(file.status);
      expect(states.some((s) => s.index === file.index && s.phase === 'exporting')).toBe(true);
    }
    // The encrypted source lost its protection: an honesty notice, not silence.
    const encrypted = report.files[3];
    expect(encrypted?.status).toBe('done-with-notes');
    expect(encrypted?.notices.map((n) => n.code)).toContain('export.security');

    for (const [index, pages] of [
      [0, 3],
      [1, 2],
      [2, 3],
      [3, 3],
    ] as const) {
      const bytes = await outputBytes(result, index);
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      expect(pdf.getPageCount()).toBe(pages);
      expect(pdf.isEncrypted).toBe(false);
      const text = await pageText(bytes, 0);
      expect(text).toContain(`1 / ${pages}`);
    }
    // Page 2 of the first file carries its own number.
    expect(await pageText(await outputBytes(result, 0), 1)).toContain('2 / 3');
  });

  it('reports a damaged file and goes on with the others', async () => {
    const garbage = new File(
      [new TextEncoder().encode('%PDF-1.7\nnot really a PDF\n')],
      'garbage.pdf',
      {
        type: 'application/pdf',
      },
    );
    const files = [
      garbage,
      await fixtureFile(truncatedUrl, 'truncated.pdf'),
      await fixtureFile(simpleUrl, 'simple-text.pdf'),
      new File([], 'empty.pdf'),
      new File(['hello'], 'notes.txt'),
    ];
    const plan = planFor(builtIn('strip-metadata'), files);
    expect(plan.skipped).toEqual([
      { name: 'empty.pdf', reason: 'empty' },
      { name: 'notes.txt', reason: 'not-pdf' },
    ]);
    const result = await runRecipe(plan, files);
    const byName = new Map(result.report.files.map((f) => [f.name, f]));
    expect(byName.get('garbage.pdf')).toMatchObject({
      status: 'failed',
      failure: { reason: 'corrupt' },
    });
    // PDFium rebuilds truncated.pdf by scanning its objects: it is done, with a note that the
    // output was built from the repaired copy; or, if the engine refuses it, it fails alone.
    const truncated = byName.get('truncated.pdf');
    if (truncated?.status === 'failed') {
      expect(truncated.failure?.reason).toBe('corrupt');
    } else {
      expect(truncated?.status).toBe('done-with-notes');
      expect(truncated?.notices.map((n) => n.code)).toContain('export.repaired');
    }
    expect(byName.get('simple-text.pdf')?.status).toBe('done');
    expect(byName.get('empty.pdf')).toMatchObject({ status: 'skipped', skipReason: 'empty' });
    expect(byName.get('notes.txt')).toMatchObject({ status: 'skipped', skipReason: 'not-pdf' });
    expect(result.report.totals.skipped).toBe(2);
    expect(result.outputs.map((o) => o.name)).toContain('simple-text-Strip metadata.pdf');
  });

  it('fails an encrypted file whose password the user skips', async () => {
    const files = [
      await fixtureFile(encryptedUrl, 'encrypted-aes-128.pdf'),
      await fixtureFile(simpleUrl, 'simple-text.pdf'),
    ];
    const asked: boolean[] = [];
    const result = await runRecipe(planFor(builtIn('number-pages'), files), files, {
      askPassword: ({ incorrect }) => {
        asked.push(incorrect);
        // A wrong password first, then the user skips the file.
        return Promise.resolve(asked.length === 1 ? 'wrong' : null);
      },
    });
    expect(asked).toEqual([false, true]);
    expect(result.report.files[0]).toMatchObject({
      status: 'failed',
      failure: { reason: 'password' },
    });
    expect(result.report.files[1]?.status).toBe('done');
  });
});

describe('run control', () => {
  it('stops between files when cancelled and reports the rest as not started', async () => {
    const files = await Promise.all(
      ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map((name) => fixtureFile(simpleUrl, name)),
    );
    // Continuous Bates runs one file at a time, so "between files" is exact.
    const bates = recipe('Stamp', [
      {
        kind: 'bates',
        options: {
          prefix: 'X-',
          width: 6,
          start: 1,
          suffix: '',
          anchor: 'bottom-right',
          marginX: 36,
          marginY: 28,
          style: {
            family: 'JetBrains Mono',
            size: 9,
            bold: false,
            italic: false,
            color: '#000000',
            opacity: 1,
          },
          continuous: true,
        },
      },
    ]);
    const controller = new AbortController();
    const started: string[] = [];
    const result = await runRecipe(planFor(bates, files), files, {
      signal: controller.signal,
      onFile: (state) => {
        if (state.phase === 'opening') started.push(state.name);
        if (state.name === 'a.pdf' && state.phase === 'done') controller.abort();
      },
    });
    expect(started).toEqual(['a.pdf']);
    expect(result.report.cancelled).toBe(true);
    expect(result.report.files.map((f) => f.status)).toEqual([
      'done',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(result.report.files[1]?.skipReason).toBe('cancelled');
    expect(result.outputs).toHaveLength(1);
  });

  it('continues Bates numbers from one file to the next', async () => {
    const files = [
      await fixtureFile(simpleUrl, 'first.pdf'),
      await fixtureFile(imagesUrl, 'second.pdf'),
    ];
    const bates = recipe('Bates', [
      {
        kind: 'bates',
        options: {
          prefix: 'ACME-',
          width: 4,
          start: 10,
          suffix: '',
          anchor: 'bottom-right',
          marginX: 36,
          marginY: 28,
          style: {
            family: 'Inter',
            size: 9,
            bold: false,
            italic: false,
            color: '#000000',
            opacity: 1,
          },
          continuous: true,
        },
      },
    ]);
    const result = await runRecipe(planFor(bates, files), files);
    expect(result.report.totals.failed).toBe(0);
    expect(await pageText(await outputBytes(result, 0), 0)).toContain('ACME-0010');
    expect(await pageText(await outputBytes(result, 0), 2)).toContain('ACME-0012');
    // simple-text has 3 pages: the second file starts at 13.
    expect(await pageText(await outputBytes(result, 1), 0)).toContain('ACME-0013');
  });

  it('encrypts with the password asked once and never puts it in the report', async () => {
    const password = 'Batch-Secret-7788';
    const files = [
      await fixtureFile(formsUrl, 'forms-a.pdf'),
      await fixtureFile(simpleUrl, 'simple-text.pdf'),
    ];
    const plan = planFor(builtIn('share-safely'), files);
    expect(plan.inputs).toHaveLength(1);
    const input = plan.inputs[0];
    if (!input) throw new Error('no input');
    const result = await runRecipe(plan, files, { values: new Map([[input.id, password]]) });
    expect(result.report.totals.failed).toBe(0);
    for (const index of [0, 1]) {
      // Locked without the password, readable with it.
      const bytes = await outputBytes(result, index);
      await expect(pageText(bytes, 0)).rejects.toThrow();
      await expect(pageText(bytes, 0, password)).resolves.toBeTypeOf('string');
    }
    expect(await pageText(await outputBytes(result, 1), 0, password)).toContain(
      'PAGE 1 OF simple-text',
    );
    // Forms were flattened: the form is gone from the first output.
    const flat = await PDFDocument.load(await outputBytes(result, 0), {
      updateMetadata: false,
      password,
    });
    expect(flat.getForm().getFields()).toHaveLength(0);
    assertNoSecrets(JSON.stringify(result.report), [password]);
  });

  it('refuses a plan with steps this build cannot run', async () => {
    const files = [await fixtureFile(simpleUrl, 'simple-text.pdf')];
    const plan = planFor(builtIn('scan-to-searchable'), files);
    expect(plan.runnable).toBe(false);
    await expect(runRecipe(plan, files)).rejects.toThrow(/cannot run/);
  });
});

describe('other outputs and steps', () => {
  it('renders each file as images (a ZIP per file) from the private workspace', async () => {
    const files = [await fixtureFile(simpleUrl, 'simple-text.pdf')];
    const images = recipe('Pictures', [
      { kind: 'rotate', options: { quarterTurns: 1, pages: 'first' } },
      {
        kind: 'export',
        options: {
          format: 'images',
          imageFormat: 'png',
          dpi: 36,
          quality: 90,
          background: 'white',
        },
      },
    ]);
    const result = await runRecipe(planFor(images, files), files);
    expect(result.report.files[0]?.status).toBe('done');
    const output = result.outputs[0];
    expect(output?.name).toBe('simple-text-Pictures.zip');
    const bytes = new Uint8Array(await (output?.entry.data.arrayBuffer() ?? new ArrayBuffer(0)));
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('stamps an image watermark and a header embedded in the recipe', async () => {
    const png = await pngBlob('mark.png', 40, 20);
    let binary = '';
    for (const byte of new Uint8Array(png.bytes)) binary += String.fromCharCode(byte);
    const files = [await fixtureFile(simpleUrl, 'simple-text.pdf')];
    const stamped = recipe('Stamped', [
      {
        kind: 'watermark',
        options: {
          mode: 'image',
          text: '',
          style: {
            family: 'Inter',
            size: 10,
            bold: false,
            italic: false,
            color: '#000000',
            opacity: 0.5,
          },
          image: { type: 'image/png', data: btoa(binary) },
          scale: 1,
          rotate: 0,
          tile: false,
          gapX: 72,
          gapY: 72,
          layer: 'over',
          range: { mode: 'odd' },
        },
      },
      {
        kind: 'header-footer',
        options: {
          slots: {
            'top-left': '{title}',
            'top-center': '',
            'top-right': '',
            'bottom-left': '',
            'bottom-center': '',
            'bottom-right': 'p. {page}',
          },
          marginX: 36,
          marginY: 28,
          style: {
            family: 'Inter',
            size: 9,
            bold: false,
            italic: false,
            color: '#404040',
            opacity: 1,
          },
          range: { mode: 'all' },
          mirror: false,
        },
      },
    ]);
    const result = await runRecipe(planFor(stamped, files), files);
    expect(result.report.files[0]?.status).toBe('done');
    const bytes = await outputBytes(result, 0);
    expect(await pageText(bytes, 1)).toContain('p. 2');
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const images = (index: number) =>
      pdf
        .getPage(index)
        .node.normalizedEntries()
        .XObject?.keys()
        .filter((key) => key.asString().startsWith('/Im')).length ?? 0;
    // Odd pages only (1 and 3 of 3).
    expect([images(0), images(1), images(2)]).toEqual([1, 0, 1]);
  });

  it('crops, resizes and deletes pages; a step that would delete everything fails the file', async () => {
    const files = [await fixtureFile(simpleUrl, 'simple-text.pdf')];
    const shape = recipe('Shape', [
      { kind: 'delete-pages', options: { pages: 'last' } },
      {
        kind: 'crop',
        options: { margins: { top: 72, right: 0, bottom: 0, left: 0 }, pages: 'all' },
      },
      {
        kind: 'page-size',
        options: { preset: 'a4', mode: 'fit', anchor: 'center', pages: { ranges: [{ from: 2 }] } },
      },
    ]);
    const result = await runRecipe(planFor(shape, files), files);
    expect(result.report.files[0]?.status).toBe('done');
    const pdf = await PDFDocument.load(await outputBytes(result, 0), { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(2);
    // Letter (612 × 792) cropped by an inch at the top; page 2 resized to A4.
    expect(pdf.getPage(0).getCropBox().height).toBeCloseTo(720, 0);
    expect(pdf.getPage(1).getMediaBox().width).toBeCloseTo(595.28, 1);

    const two = [await fixtureFile(formsUrl, 'forms-a.pdf')];
    const deleteAll = recipe('Too much', [
      { kind: 'delete-pages', options: { pages: { ranges: [{ from: 1 }] } } },
    ]);
    const failed = await runRecipe(planFor(deleteAll, two), two);
    expect(failed.report.files[0]).toMatchObject({
      status: 'failed',
      failure: { reason: 'step', stepIndex: 0 },
    });
  });

  it('converts each file to Markdown, images in a ZIP, with the dialog’s honesty notes', async () => {
    const files = [await fixtureFile(markdownUrl, 'markdown-source.pdf')];
    const markdown = recipe('Notes', [
      { kind: 'remove-password', options: {} },
      { kind: 'export', options: { format: 'markdown' } },
    ]);
    const plan = planFor(markdown, files);
    expect(plan.runnable).toBe(true);
    const states: BatchFileState[] = [];
    const result = await runRecipe(plan, files, { onFile: (state) => states.push(state) });

    const outcome = result.report.files[0];
    expect(outcome?.status).toBe('done-with-notes');
    expect(outcome?.outputName).toBe('markdown-source-Notes.zip');
    expect(outcome?.notices.map((n) => n.code)).toEqual([
      'export.text-ignored',
      'convert.reading-order',
      'convert.tables',
      'convert.dropped',
    ]);
    expect(outcome?.notices[1]?.message).toMatch(/^Reading order and headings are reconstructed/);
    expect(outcome?.notices[3]?.message).toBe(
      '4 running header, footer or page-number lines left out.',
    );
    const output = result.outputs[0];
    expect(output).toMatchObject({ name: 'markdown-source-Notes.zip', type: 'application/zip' });
    const zip = await unzip(await outputBytes(result, 0));
    expect([...zip.keys()]).toEqual(['document.md', 'images/p1-1.png']);
    expect(new TextDecoder().decode(zip.get('document.md'))).toBe(golden);
    expect([...(zip.get('images/p1-1.png') ?? new Uint8Array()).subarray(0, 4)]).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    // No tab was involved: the file went through the private steps and the conversion.
    expect(states.some((s) => s.phase === 'exporting')).toBe(true);
  }, 60_000);

  it('converts to plain text after the steps, page breaks marked as asked', async () => {
    const files = [
      await fixtureFile(simpleUrl, 'simple-text.pdf'),
      await fixtureFile(markdownUrl, 'markdown-source.pdf'),
    ];
    const text = recipe('Text', [
      { kind: 'delete-pages', options: { pages: 'last' } },
      { kind: 'export', options: { format: 'text', pageBreaks: 'comment' } },
    ]);
    const result = await runRecipe(planFor(text, files), files);
    expect(result.report.totals.failed).toBe(0);
    expect(result.outputs.map((o) => [o.name, o.type])).toEqual([
      ['simple-text-Text.txt', 'text/plain'],
      ['markdown-source-Text.txt', 'text/plain'],
    ]);
    const body = (n: number) =>
      `This is page ${n} of a three-page US Letter document set in Helvetica. The quick brown fox jumps over the lazy dog.`;
    // Page 3 was deleted; the break between the two pages left is marked, and the running
    // "PAGE n OF simple-text" line is left out (with its notice).
    expect(new TextDecoder().decode(await outputBytes(result, 0))).toBe(
      `${body(1)}\n\n[page 2]\n\n${body(2)}\n`,
    );
    expect(result.report.files[0]?.notices.map((n) => n.code)).toContain('convert.dropped');
    const second = new TextDecoder().decode(await outputBytes(result, 1));
    expect(second).toContain('Working with PDF Fixtures');
    expect(second).not.toContain('Two columns');
    expect(second).not.toContain('![');
    expect(result.report.files[1]?.notices.map((n) => n.code)).toContain('convert.reading-order');
  }, 60_000);

  it('keeps running lines and line-end hyphens when the step asks', async () => {
    const files = [await fixtureFile(markdownUrl, 'markdown-source.pdf')];
    const keep = recipe('Keep', [
      {
        kind: 'export',
        options: { format: 'text', keepHeadersFooters: true, joinHyphens: false },
      },
    ]);
    const choices: unknown[] = [];
    const result = await runRecipe(
      planFor(keep, files),
      files,
      {},
      {
        ...defaultBatchDependencies(),
        convert: (ws, documentId, choice, deps, control) => {
          choices.push(choice);
          return convertWorkspaceDocument(ws, documentId, choice, deps, control);
        },
      },
    );
    expect(choices).toEqual([
      expect.objectContaining({
        format: 'text',
        keepHeadersFooters: true,
        joinHyphens: false,
        images: false,
      }),
    ]);
    const content = new TextDecoder().decode(await outputBytes(result, 0));
    // The golden (defaults) drops "Fixture Handbook" and joins "gener-" + "ated".
    expect(content).toContain('Fixture Handbook');
    expect(content).toContain('gener-');
    expect(content).not.toContain('is generated by');
    expect(result.report.files[0]?.notices.map((n) => n.code)).not.toContain('convert.dropped');
  }, 60_000);

  it('converts the pages as the PDF would draw them when the steps add furniture', async () => {
    const files = [await fixtureFile(simpleUrl, 'simple-text.pdf')];
    const stamped = recipe('Stamped text', [
      {
        kind: 'watermark',
        options: {
          mode: 'text',
          text: 'CONFIDENTIAL',
          style: {
            family: 'Inter',
            size: 40,
            bold: false,
            italic: false,
            color: '#808080',
            opacity: 0.3,
          },
          scale: 1,
          rotate: 0,
          tile: false,
          gapX: 72,
          gapY: 72,
          layer: 'over',
          range: { mode: 'custom', from: 1, to: 1 },
        },
      },
      { kind: 'export', options: { format: 'text' } },
    ]);
    const result = await runRecipe(planFor(stamped, files), files);
    expect(result.report.files[0]?.status).toBe('done-with-notes');
    const content = new TextDecoder().decode(await outputBytes(result, 0));
    // Page 1 only carries the watermark, drawn by the assembled copy.
    expect(content.split('\n\n')).toEqual([
      expect.stringMatching(/^This is page 1 /),
      'CONFIDENTIAL',
      expect.stringMatching(/^This is page 2 /),
      expect.stringMatching(/^This is page 3 /),
    ]);
  }, 60_000);

  it('stops a conversion when the run is cancelled', async () => {
    const files = [await fixtureFile(markdownUrl, 'markdown-source.pdf')];
    const markdown = recipe('Cancelled', [{ kind: 'export', options: { format: 'markdown' } }]);
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const result = await runRecipe(
      planFor(markdown, files),
      files,
      { signal: controller.signal },
      {
        ...defaultBatchDependencies(),
        // Cancel once the conversion is under way (the real one, in the analysis worker).
        convert: (ws, documentId, choice, deps, control) => {
          signals.push(control?.signal);
          const running = convertWorkspaceDocument(ws, documentId, choice, deps, control);
          controller.abort();
          return running;
        },
      },
    );
    expect(signals).toEqual([controller.signal]);
    expect(result.report.cancelled).toBe(true);
    expect(result.report.files[0]).toMatchObject({
      status: 'failed',
      failure: { reason: 'aborted' },
    });
    expect(result.outputs).toHaveLength(0);
  }, 60_000);
});
