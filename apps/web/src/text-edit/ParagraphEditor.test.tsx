/**
 * The paragraph editor with a mocked engine (craft spec §4.7–§4.10, §9): it opens with the
 * mirror focused and labelled, typing redraws the canvas with no engine call, a pause runs
 * one dry run and shows its preview, Esc after a change commits once and with no change
 * commits nothing, substitutions show the honesty line (and are announced), and IME
 * composition goes through the mirror.
 */
import type { SourceId } from '@pdf-editor/document-model';
import type {
  GlyphOutlineSegment,
  ParagraphEditResult,
  ParagraphLayoutAnalysis,
  ParagraphPreview,
} from '@pdf-editor/engine';
import { faceFamilyName } from '@pdf-editor/engine/fonts';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import type { PageTarget } from '../annotations/annotation-store';
import { getEngineService } from '../engine/engine-service';
import { useAnnouncer } from '../shell/announcer';
import type { PageFrame } from '../viewer/geometry';
import { ADVANCE, FONT, monoStyle, paragraph } from './paragraph-fixtures';
import type * as Actions from './actions';
import { setLocale } from '../i18n';
import {
  honestyLines,
  ParagraphEditor,
  previewPlacement,
  substituteCssFamily,
  PREVIEW_DELAY_MS,
} from './ParagraphEditor';
import { type ParagraphSession, useTextEditStore } from './text-edit-store';

const commits = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock('./actions', async (importOriginal) => {
  const actual = await importOriginal<typeof Actions>();
  return {
    ...actual,
    commitParagraphEdit: (commit: unknown) => {
      commits.calls.push(commit);
      return Promise.resolve({ ok: true, label: 'Paragraph edited (same font)' });
    },
  };
});

const LINES = ['The quick brown fox', 'jumps over the lazy', 'dog and runs away.'];
const SQUARE: GlyphOutlineSegment[] = [
  { kind: 'move', x: 0, y: 0, close: false },
  { kind: 'line', x: 0.5, y: 0, close: false },
  { kind: 'line', x: 0.5, y: 0.7, close: true },
];

const FRAME: PageFrame = {
  size: { width: 612, height: 792 },
  originX: 0,
  originY: 0,
  rotation: 0,
  scale: 1,
};

let serial = 0;

function setupEngine(options: { substitute?: boolean; sans?: boolean } = {}) {
  const source = `src-paragraph-${++serial}` as SourceId;
  const fixture = paragraph(LINES, { width: 20 * ADVANCE, source });
  const style = options.sans
    ? // Noto Sans for what it has, Inter for the arrow it lacks (craft §4.5).
      monoStyle({
        substitute: {
          font: 'NotoSans-Regular',
          advances: { ğ: ADVANCE, '→': ADVANCE },
          fonts: { '→': 'Inter-Regular' },
        },
      })
    : options.substitute
      ? monoStyle({
          substitute: { font: 'NotoSerif-Regular', advances: { ğ: ADVANCE, ş: ADVANCE } },
        })
      : monoStyle();
  const substitute = options.sans
    ? {
        face: 'NotoSans-Regular',
        family: 'Noto Sans',
        scale: 1,
        faces: ['NotoSans-Regular', 'Inter-Regular'],
      }
    : { face: 'NotoSerif-Regular', family: 'Noto Serif', scale: 1 };
  const analysis: ParagraphLayoutAnalysis = {
    ref: fixture.block.ref,
    text: fixture.block.text,
    input: { ...fixture.input, styles: { s0: style } },
    styles: {
      s0: {
        fontId: 0,
        font: FONT,
        fontSize: 10,
        size: 10,
        matrix: [1, 0, 0, 1, 0, 0],
        fill: [0, 0, 0, 255],
        renderMode: 0,
        substitute,
      },
    },
    gapBelow: fixture.gapBelow,
    paragraphGap: fixture.paragraphGap,
  };
  const service = getEngineService();
  const spies = {
    analyze: vi.spyOn(service, 'analyzeParagraphLayout').mockResolvedValue(analysis),
    glyphs: vi
      .spyOn(service, 'glyphPaths')
      .mockImplementation((_s, _p, _f, chars) =>
        Promise.resolve(Object.fromEntries(chars.map((c) => [c, c === ' ' ? null : SQUARE]))),
      ),
    preview: vi
      .spyOn(service, 'renderParagraphPreview')
      .mockImplementation(async (_s, _p, edit) => {
        const bitmap = await createImageBitmap(new ImageData(8, 4));
        // As the writer reports them: the layout's substitutions with each face's family.
        const substitutions = (edit.layout?.substituted ?? []).map((sub) => ({
          ...sub,
          family: faceFamilyName(sub.font),
        }));
        const result = {
          committed: false,
          honesty: substitutions.length > 0 ? 'font-substituted' : 'same-font',
          substitutions,
          layout: edit.layout,
        } as unknown as ParagraphEditResult;
        const preview: ParagraphPreview = {
          bitmap,
          width: 8,
          height: 4,
          clip: { x: 72, y: 670, width: 120, height: 40 },
          result,
        };
        return preview;
      }),
    dryRun: vi.spyOn(service, 'applyParagraphEdit'),
  };
  const target: PageTarget = {
    source,
    pageIndex: 0,
    pageId: `page-${serial}` as PageTarget['pageId'],
    position: 1,
  };
  const session: ParagraphSession = { target, block: fixture.block, revision: 0, caret: 4 };
  return { spies, session, fixture };
}

function renderEditor(session: ParagraphSession) {
  act(() => useTextEditStore.getState().openParagraph(session));
  const view = render(<ParagraphEditor session={session} frame={FRAME} revision={0} />);
  const mirror = screen.getByRole('textbox', { name: 'Paragraph on page 1' });
  return { ...view, mirror };
}

async function ready(mirror: HTMLElement) {
  await waitFor(() => expect(mirror).toHaveFocus());
  await waitFor(() => expect(mirror.textContent).toBe(LINES.join(' ')));
}

describe('ParagraphEditor', () => {
  beforeEach(() => {
    commits.calls.length = 0;
    useTextEditStore.getState().close();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTextEditStore.getState().close();
  });

  it('opens with the labelled multi-line mirror focused and the caret at the click', async () => {
    const { session } = setupEngine();
    const { mirror } = renderEditor(session);
    await ready(mirror);
    expect(mirror).toHaveAttribute('aria-multiline', 'true');
    expect(mirror).toHaveAttribute('contenteditable', 'true');
    const selection = window.getSelection();
    expect(selection?.focusOffset).toBe(4);
    expect(screen.getByTestId('paragraph-header')).toHaveAccessibleName('Paragraph editing');
  });

  it('types into the model and redraws the canvas without any engine call', async () => {
    const { session, spies } = setupEngine();
    const { mirror } = renderEditor(session);
    await ready(mirror);
    const clear = vi.spyOn(CanvasRenderingContext2D.prototype, 'clearRect');
    const fill = vi.spyOn(CanvasRenderingContext2D.prototype, 'fill');
    const calls = spies.analyze.mock.calls.length;
    await userEvent.keyboard('very ');
    await waitFor(() =>
      expect(mirror.textContent).toBe(
        'The very quick brown fox jumps over the lazy dog and runs away.',
      ),
    );
    expect(clear.mock.calls.length).toBeGreaterThanOrEqual(5);
    // The rewritten lines are drawn from the glyph outlines.
    expect(fill.mock.calls.length).toBeGreaterThan(0);
    expect(spies.analyze.mock.calls.length).toBe(calls);
    expect(spies.preview).not.toHaveBeenCalled();
    expect(spies.dryRun).not.toHaveBeenCalled();
  });

  it('runs one dry run after a pause and shows its preview; typing returns to the canvas', async () => {
    const { session, spies } = setupEngine();
    const { mirror, container } = renderEditor(session);
    await ready(mirror);
    // Typed key by key: a loaded machine can stretch a gap past the pause, and a preview
    // for that gap is correct. None comes while keys follow within the pause.
    const times: number[] = [];
    for (const key of 'abc') {
      times.push(performance.now());
      await userEvent.keyboard(key);
    }
    const pauses = times.slice(1).filter((t, k) => t - (times[k] ?? t) >= PREVIEW_DELAY_MS).length;
    expect(spies.preview.mock.calls.length).toBeLessThanOrEqual(pauses);
    await waitFor(
      () =>
        expect(spies.preview.mock.calls.at(-1)?.[2]?.text).toBe(
          'The abcquick brown fox jumps over the lazy dog and runs away.',
        ),
      { timeout: 2000 },
    );
    const previews = spies.preview.mock.calls.length;
    expect(previews).toBeLessThanOrEqual(1 + pauses);
    const edit = spies.preview.mock.calls.at(-1)?.[2];
    expect(edit?.caretSpan).toEqual({ start: 4, end: 4 });
    expect(edit?.layout).toBeDefined();
    await waitFor(() =>
      expect(container.querySelector('[data-paragraph-editor]')).toHaveAttribute('data-preview'),
    );
    expect(screen.getByTestId('paragraph-preview')).toBeInTheDocument();
    // Moving the caret keeps the preview; typing returns to the canvas.
    await userEvent.keyboard('{ArrowLeft}');
    expect(container.querySelector('[data-paragraph-editor]')).toHaveAttribute('data-preview');
    await userEvent.keyboard('d');
    expect(container.querySelector('[data-paragraph-editor]')).not.toHaveAttribute('data-preview');
    expect(spies.preview).toHaveBeenCalledTimes(previews);
  });

  it('commits once on Esc after a change', async () => {
    const { session } = setupEngine();
    const { mirror } = renderEditor(session);
    await ready(mirror);
    await userEvent.keyboard('X');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(useTextEditStore.getState().paragraph).toBeNull());
    expect(commits.calls).toHaveLength(1);
    expect(commits.calls[0]).toMatchObject({
      text: 'The Xquick brown fox jumps over the lazy dog and runs away.',
      caretSpan: { start: 4, end: 4 },
      style: 's0',
      honesty: { honesty: 'same-font', substitutions: [] },
    });
    cleanup();
    // Unmounting after the commit does not commit again.
    expect(commits.calls).toHaveLength(1);
  });

  it('opened from a run, Esc asks for the focus to return to that run', async () => {
    const { session } = setupEngine();
    const run = { ...session.block.ref.runs[0], glyphs: [] } as unknown as NonNullable<
      ParagraphSession['fallback']
    >['run'];
    const withRun: ParagraphSession = {
      ...session,
      fallback: { target: session.target, run, revision: 0, selection: { start: 0, end: 0 } },
    };
    const { mirror } = renderEditor(withRun);
    await ready(mirror);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(useTextEditStore.getState().paragraph).toBeNull());
    expect(useTextEditStore.getState().focusReturn).toMatchObject({
      pageId: session.target.pageId,
      run: { objectPath: [0] },
    });
    expect(useTextEditStore.getState().focusReturn?.staleRevision).toBeUndefined();
    expect(commits.calls).toHaveLength(0);
  });

  it('commits nothing on Esc without a change', async () => {
    const { session } = setupEngine();
    const { mirror } = renderEditor(session);
    await ready(mirror);
    await userEvent.keyboard('X{Backspace}');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(useTextEditStore.getState().paragraph).toBeNull());
    expect(commits.calls).toHaveLength(0);
  });

  it('a press outside commits a change', async () => {
    const { session } = setupEngine();
    const { mirror } = renderEditor(session);
    await ready(mirror);
    await userEvent.keyboard('Y');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await waitFor(() => expect(commits.calls).toHaveLength(1));
  });

  it('shows and announces the honesty line for substituted characters', async () => {
    const { session } = setupEngine({ substitute: true });
    const { mirror } = renderEditor(session);
    await ready(mirror);
    await userEvent.keyboard('ğ');
    await waitFor(() =>
      expect(screen.getByTestId('paragraph-honesty')).toHaveTextContent(
        '‘ğ’ uses Noto Serif because the original font in this file does not include it.',
      ),
    );
    await userEvent.keyboard('ş');
    await waitFor(() =>
      expect(screen.getByTestId('paragraph-honesty')).toHaveTextContent(
        '‘ğ’ and ‘ş’ use Noto Serif because the original font in this file does not include them.',
      ),
    );
    expect(useAnnouncer.getState().message).toContain('use Noto Serif');
    // The mirror is described by the header that holds the line.
    const header = screen.getByTestId('paragraph-header');
    expect(mirror.getAttribute('aria-describedby')).toBe(header.id);
  });

  it('names, per character, the face the layout sets it in', async () => {
    const { session } = setupEngine({ sans: true });
    const { mirror } = renderEditor(session);
    await ready(mirror);
    await userEvent.keyboard('ğ→');
    await waitFor(() =>
      expect(screen.getAllByTestId('paragraph-honesty').map((p) => p.textContent)).toEqual([
        '‘ğ’ uses Noto Sans because the original font in this file does not include it.',
        '‘→’ uses Inter because the original font in this file does not include it.',
      ]),
    );
  });

  it('shows a character no bundled face has as unsupported in the header', async () => {
    const { session } = setupEngine({ sans: true });
    const { mirror } = renderEditor(session);
    await ready(mirror);
    await userEvent.keyboard('क');
    await waitFor(() =>
      expect(screen.getByTestId('paragraph-header')).toHaveTextContent('No available font has ‘क’'),
    );
    expect(screen.queryByTestId('paragraph-honesty')).toBeNull();
  });

  it('takes IME composition through the mirror', async () => {
    const { session } = setupEngine();
    const { mirror, container } = renderEditor(session);
    await ready(mirror);
    const root = container.querySelector('[data-paragraph-editor]');
    act(() => {
      mirror.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      mirror.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 's' }));
    });
    expect(root).toHaveAttribute('data-composing');
    act(() => {
      mirror.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'ş' }));
      mirror.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ş' }));
    });
    expect(root).not.toHaveAttribute('data-composing');
    await waitFor(() =>
      expect(mirror.textContent).toBe(
        'The şquick brown fox jumps over the lazy dog and runs away.',
      ),
    );
  });

  it('crosses lines with the arrows and selects the paragraph with Mod+A', async () => {
    const { session } = setupEngine();
    const { mirror } = renderEditor(session);
    await ready(mirror);
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(window.getSelection()?.focusOffset).toBe(24));
    await userEvent.keyboard('{Control>}a{/Control}');
    await waitFor(() => {
      const selection = window.getSelection();
      expect(selection?.anchorOffset).toBe(0);
      expect(selection?.focusOffset).toBe(LINES.join(' ').length);
    });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(mirror.textContent).toBe('\n'));
  });
});

describe('helpers', () => {
  it('groups the honesty line by substitute face, in the spec’s words', () => {
    expect(
      honestyLines([
        { char: 'ğ', family: 'Noto Serif' },
        { char: 'ş', family: 'Noto Serif' },
        { char: 'ğ', family: 'Noto Serif' },
      ]),
    ).toEqual([
      '‘ğ’ and ‘ş’ use Noto Serif because the original font in this file does not include them.',
    ]);
    expect(honestyLines([])).toEqual([]);
    expect(
      honestyLines([
        { char: 'ğ', family: 'Noto Sans' },
        { char: '→', family: 'Inter' },
      ]),
    ).toEqual([
      '‘ğ’ uses Noto Sans because the original font in this file does not include it.',
      '‘→’ uses Inter because the original font in this file does not include it.',
    ]);
  });

  it('says the honesty line in Turkish', () => {
    setLocale('tr');
    try {
      expect(honestyLines([{ char: 'ğ', family: 'Noto Serif' }])).toEqual([
        '‘ğ’ için Noto Serif kullanılıyor, çünkü bu dosyadaki özgün yazı tipinde bu karakter yok.',
      ]);
      expect(
        honestyLines([
          { char: 'ğ', family: 'Noto Serif' },
          { char: 'ş', family: 'Noto Serif' },
        ]),
      ).toEqual([
        '‘ğ’ ve ‘ş’ için Noto Serif kullanılıyor, çünkü bu dosyadaki özgün yazı tipinde bu karakterler yok.',
      ]);
    } finally {
      setLocale('en');
    }
  });

  it('draws substitutes with the engine’s fallback chain of bundled faces', () => {
    const info = {
      font: FONT,
      fontSize: 10,
      size: 10,
      matrix: [1, 0, 0, 1, 0, 0] as const,
      renderMode: 0,
      substitute: {
        face: 'NotoSans-Regular',
        family: 'Noto Sans',
        scale: 1,
        faces: ['NotoSans-Regular', 'Inter-Regular'],
      },
    };
    expect(substituteCssFamily(info, '"Noto Sans", sans-serif')).toBe(
      '"pdfe-furniture-NotoSans-Regular", "pdfe-furniture-Inter-Regular", "Noto Sans", sans-serif',
    );
    const serif = {
      ...info,
      substitute: { face: 'NotoSerif-Regular', family: 'Noto Serif', scale: 1 },
    };
    expect(substituteCssFamily(serif, '"Noto Serif", serif')).toBe(
      '"pdfe-furniture-NotoSerif-Regular", "Noto Serif", serif',
    );
  });

  it('places the preview at its clip, turned only by the view rotation', () => {
    const clip = { x: 72, y: 600, width: 200, height: 50 };
    expect(previewPlacement(FRAME, clip)).toEqual({ left: 72, top: 142, width: 200, height: 50 });
    // The page's own /Rotate is in the bitmap already.
    const own = { ...FRAME, rotation: 90 as const, intrinsicRotation: 90 as const };
    expect(previewPlacement(own, clip).transform).toBeUndefined();
    // A view rotation turns it about the box centre.
    const viewed = previewPlacement({ ...FRAME, rotation: 90 as const }, clip);
    expect(viewed).toMatchObject({ width: 200, height: 50, transform: 'rotate(90deg)' });
  });
});
