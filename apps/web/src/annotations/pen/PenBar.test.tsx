/**
 * The pen bar (experience-redesign spec §6.2, §7.4, §10): four ink dots, tap to arm (nothing
 * opens), tap the armed one again for its editor, the editor's swatches, width stops and
 * sliders and "Reset to default", the keyboard path, and the tier's honesty note once a pen
 * with pressure has been seen. Vitest browser mode.
 */
import '../../styles/tokens.css';
import '../../styles/reset.css';
import '../../styles/global.css';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { useAnnouncer } from '../../shell/announcer';
import { resetToolStore, useToolStore } from '../../viewer/tool-store';
import {
  resetAnnotationStore,
  TOOL_STYLES_STORAGE_KEY,
  useAnnotationStore,
} from '../annotation-store';
import { INK, INKS, TINT, TINTS } from '../palette';
import { penSession, resetPenSession } from './ink-input';
import { PenBar, PenTier } from './PenBar';
import {
  contrastRatio,
  DEFAULT_PRESETS,
  DOT_CONTRAST_MIN,
  HIGHLIGHTER_SWATCHES,
  needsDotRing,
  overRgb,
  PEN_PRESETS_STORAGE_KEY,
  PEN_SWATCHES,
  type PenPreset,
  type Rgb,
} from './presets';

const store = () => useAnnotationStore.getState();

function Harness() {
  const armed = useToolStore((s) => s.mode === 'ink');
  return (
    <div role="toolbar" aria-label="Tools">
      <PenBar armed={armed} arm={() => useToolStore.getState().setMode('ink')} />
      <button type="button">Eraser</button>
      <div data-testid="tier">
        <PenTier />
      </div>
    </div>
  );
}

const presets = () => screen.getByRole('radiogroup', { name: 'Pen presets' });
const dot = (name: string | RegExp) => within(presets()).getByRole('radio', { name });
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe('pen bar', () => {
  beforeEach(() => {
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetToolStore();
    resetPenSession();
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem(TOOL_STYLES_STORAGE_KEY);
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetToolStore();
    resetPenSession();
  });

  it('shows four ink dots of their real colour, sized by width, the highlighter a capsule', () => {
    render(<Harness />);
    const radios = within(presets()).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Black pen, 1.5 pt',
      'Blue pen, 1.5 pt',
      'Red pen, 2 pt',
      'Yellow highlighter, 12 pt',
    ]);
    const marks = radios.map((r) => r.querySelector<HTMLElement>('span') as HTMLElement);
    expect(marks.map((mark) => getComputedStyle(mark).backgroundColor)).toEqual([
      'rgb(26, 26, 26)',
      'rgb(23, 96, 238)',
      'rgb(219, 28, 34)',
      // The Highlighter: its tint at full opacity (craft spec §5.4).
      'rgb(255, 234, 0)',
    ]);
    expect(marks.map((mark) => Math.round(mark.getBoundingClientRect().height))).toEqual([
      13, 13, 13, 9,
    ]);
    // The highlighter: an 18 × 9 px capsule.
    expect(Math.round(marks[3]?.getBoundingClientRect().width ?? 0)).toBe(18);
    expect(marks[3]?.dataset.shape).toBe('capsule');
    // The first preset is the pen's, but nothing is armed yet: no ring.
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios.filter((r) => r.hasAttribute('data-armed'))).toEqual([]);
  });

  it('a tap arms the preset and opens nothing; a tap on the armed one opens its editor', async () => {
    render(<Harness />);
    await userEvent.click(dot('Blue pen, 1.5 pt'));
    expect(useToolStore.getState().mode).toBe('ink');
    expect(store().pen.active).toBe(1);
    expect(store().styles.ink.color).toBe(INK.blue);
    expect(useAnnouncer.getState().message).toBe('Blue pen, 1.5 pt');
    expect(dot('Blue pen, 1.5 pt')).toHaveAttribute('data-armed');
    await frame();
    await frame();
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(dot('Blue pen, 1.5 pt'));
    const editor = await screen.findByRole('dialog', { name: 'Edit Blue pen' });
    expect(editor).toBeVisible();
    // A tap on the open preset's dot closes it again.
    await userEvent.click(dot('Blue pen, 1.5 pt'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useToolStore.getState().mode).toBe('ink');
  });

  it('the editor changes that preset: swatch, width stop, sliders, reset; Esc keeps the pen', async () => {
    render(<Harness />);
    await userEvent.click(dot(/^Blue pen/));
    await userEvent.click(dot(/^Blue pen/));
    const editor = await screen.findByRole('dialog', { name: 'Edit Blue pen' });

    await userEvent.click(within(editor).getByRole('radio', { name: 'Green' }));
    expect(store().pen.presets[1].color).toBe(INK.green);
    expect(store().styles.ink.color).toBe(INK.green);
    const named = await screen.findByRole('dialog', { name: 'Edit Green pen' });

    await userEvent.click(within(named).getByRole('radio', { name: '5 pt' }));
    expect(store().pen.presets[1].width).toBe(5);
    expect(within(named).getByRole('radio', { name: '5 pt' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const width = within(named).getByRole('slider', { name: 'Exact width' });
    expect(width).toHaveAttribute('min', '0.25');
    expect(width).toHaveAttribute('max', '24');
    fireEvent.change(width, { target: { value: '17.5' } });
    expect(store().pen.presets[1].width).toBe(17.5);
    expect(width).toHaveAttribute('aria-valuetext', '17.5 pt');
    fireEvent.change(within(named).getByRole('slider', { name: 'Opacity' }), {
      target: { value: '60' },
    });
    expect(store().pen.presets[1].opacity).toBe(0.6);
    expect(store().styles.ink).toMatchObject({ strokeWidth: 17.5, opacity: 0.6 });
    // Persisted per device.
    expect(JSON.parse(localStorage.getItem(PEN_PRESETS_STORAGE_KEY) ?? '{}')).toMatchObject({
      active: 1,
      presets: [
        DEFAULT_PRESETS[0],
        { color: INK.green, width: 17.5, opacity: 0.6 },
        DEFAULT_PRESETS[2],
        DEFAULT_PRESETS[3],
      ],
    });

    await userEvent.click(within(named).getByRole('button', { name: 'Reset to default' }));
    expect(store().pen.presets[1]).toEqual(DEFAULT_PRESETS[1]);
    expect(useAnnouncer.getState().message).toBe('Blue pen reset to default');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useToolStore.getState().mode).toBe('ink');
    await waitFor(() => expect(dot(/^Blue pen/)).toHaveFocus());
  });

  it('the editor offers the eight inks for a pen and the four tints for the highlighter', async () => {
    render(<Harness />);
    const swatchNames = (editor: HTMLElement) =>
      within(within(editor).getByRole('radiogroup', { name: 'Color' }))
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label'));

    await userEvent.click(dot(/^Black pen/));
    await userEvent.click(dot(/^Black pen/));
    const pen = await screen.findByRole('dialog', { name: 'Edit Black pen' });
    expect(swatchNames(pen)).toEqual(INKS.map((ink) => ink.name()));
    // The default colour is its swatch, never "custom".
    expect(within(pen).getByRole('radio', { name: 'Black' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(dot(/^Yellow highlighter/));
    await userEvent.click(dot(/^Yellow highlighter/));
    const highlighter = await screen.findByRole('dialog', { name: 'Edit Yellow highlighter' });
    expect(swatchNames(highlighter)).toEqual(TINTS.map((tint) => tint.name()));
    expect(within(highlighter).getByRole('radio', { name: 'Yellow' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(within(highlighter).getByRole('radio', { name: 'Pink' }));
    expect(store().pen.presets[3]).toEqual({ ...DEFAULT_PRESETS[3], color: TINT.pink });
    const pink = await screen.findByRole('dialog', { name: 'Edit Pink highlighter' });
    expect(pink).toBeVisible();
    // The Highlighter (craft spec §5.4): widths 6–18 pt, no opacity (always opaque).
    expect(
      within(within(pink).getByRole('radiogroup', { name: 'Width' }))
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['6', '8', '10', '12', '15', '18']);
    const exact = within(pink).getByRole('slider', { name: 'Exact width' });
    expect(exact).toHaveAttribute('min', '6');
    expect(exact).toHaveAttribute('max', '18');
    expect(within(pink).queryByRole('slider', { name: 'Opacity' })).toBeNull();
  });

  it('keyboard: arrows move, Enter arms, Enter on the armed opens, Shift+Enter edits', async () => {
    render(<Harness />);
    dot(/^Black pen/).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(dot(/^Blue pen/)).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(dot(/^Yellow highlighter/)).toHaveFocus();
    // Past the last preset the key is the bar's (not claimed here).
    expect(fireEvent.keyDown(dot(/^Yellow highlighter/), { key: 'ArrowRight' })).toBe(true);
    await userEvent.keyboard('{ArrowLeft}');
    expect(dot(/^Red pen/)).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(useToolStore.getState().mode).toBe('ink');
    expect(store().pen.active).toBe(2);
    await frame();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Edit Red pen' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Shift+Enter edits the focused preset without arming it.
    await waitFor(() => expect(dot(/^Red pen/)).toHaveFocus());
    await userEvent.keyboard('{ArrowLeft}{Shift>}{Enter}{/Shift}');
    const blue = await screen.findByRole('dialog', { name: 'Edit Blue pen' });
    await waitFor(() => expect(blue).toBeVisible());
    expect(store().pen.active).toBe(2);
  });

  it('dark dots get a light inner ring, 3:1 or more on the bar over a page and the canvas', () => {
    render(<Harness />);
    // The bar's fill from the tokens: the glass tint over the backdrop (the page or the
    // canvas) at the filter's brightness (saturation leaves these greys alone).
    const root = getComputedStyle(document.documentElement);
    const token = (name: string) => root.getPropertyValue(name).trim();
    const rgb = (value: string): Rgb => {
      if (value.startsWith('#')) {
        const n = Number.parseInt(value.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      const [r = 0, g = 0, b = 0] = (value.match(/[\d.]+/g) ?? []).map(Number);
      return [r, g, b];
    };
    const glass = token('--glass');
    const tintAlpha = Number(/\/\s*([\d.]+)/.exec(glass)?.[1]);
    const brightness = Number(/brightness\(([\d.]+)\)/.exec(token('--glass-filter'))?.[1]);
    expect(tintAlpha).toBeGreaterThan(0);
    expect(brightness).toBeGreaterThan(0);
    const fill = (backdrop: string): Rgb => {
      const dimmed = rgb(token(backdrop)).map((c) => c * brightness) as unknown as Rgb;
      return overRgb(rgb(glass), tintAlpha, dimmed);
    };
    const fills = { page: fill('--page-background'), canvas: fill('--surface-0') };
    const ring = rgb(token('--glass-text-secondary'));

    const inks: PenPreset[] = [
      ...DEFAULT_PRESETS,
      ...PEN_SWATCHES.map((swatch) => ({ color: swatch.color, width: 1.5, opacity: 1 })),
      ...HIGHLIGHTER_SWATCHES.map((swatch) => ({ color: swatch.color, width: 12, opacity: 0.4 })),
      ...HIGHLIGHTER_SWATCHES.map((swatch) => ({ color: swatch.color, width: 12, opacity: 1 })),
    ];
    for (const ink of inks) {
      for (const [where, under] of Object.entries(fills)) {
        const edge = needsDotRing(ink) ? ring : overRgb(rgb(ink.color), ink.opacity, under);
        expect(
          contrastRatio(edge, under),
          `${ink.color} at ${ink.opacity} over the bar on the ${where}`,
        ).toBeGreaterThanOrEqual(DOT_CONTRAST_MIN);
      }
    }
    // Black, blue and red have the ring; it is drawn in the ring colour. So does every ink of
    // the palette. The opaque Highlighter tint does not need it.
    expect(
      PEN_SWATCHES.filter((s) => !needsDotRing({ color: s.color, width: 1.5, opacity: 1 })),
    ).toEqual([]);
    expect(DEFAULT_PRESETS.map((p) => needsDotRing(p))).toEqual([true, true, true, false]);
    const marks = within(presets())
      .getAllByRole('radio')
      .map((r) => r.querySelector<HTMLElement>('span') as HTMLElement);
    expect(marks[3]).not.toHaveAttribute('data-ring');
    for (const mark of marks.slice(0, 3)) {
      expect(mark).toHaveAttribute('data-ring');
      expect(getComputedStyle(mark).borderTopColor).toBe(`rgb(${ring.join(', ')})`);
    }
    // A tint at full opacity keeps the plain swatch border.
    expect(needsDotRing({ color: TINT.yellow, width: 1.5, opacity: 1 })).toBe(false);
  });

  it('a ringed dot is filled to 70 % of its diameter, the ring outside the fill', () => {
    render(<Harness />);
    const marks = within(presets())
      .getAllByRole('radio')
      .map((r) => r.querySelector<HTMLElement>('span') as HTMLElement);
    for (const mark of marks.slice(0, 3)) {
      const style = getComputedStyle(mark);
      const outer = Number.parseFloat(style.width);
      const inner =
        outer -
        2 * Number.parseFloat(style.borderLeftWidth) -
        2 * Number.parseFloat(style.paddingLeft);
      expect(inner / outer).toBeCloseTo(0.7, 2);
      expect(style.backgroundClip).toBe('content-box');
    }
    // The capsule (the Highlighter) and unringed dots keep a full fill.
    expect(getComputedStyle(marks[3] as HTMLElement).backgroundClip).toBe('border-box');
  });

  it('the armed preset says "Esc: Select"; the editor repeats the pressure note', async () => {
    render(<Harness />);
    act(() => useToolStore.getState().setMode('ink'));
    const black = dot('Black pen, 1.5 pt');
    await userEvent.hover(black);
    await waitFor(() => expect(screen.getByText('Black pen, 1.5 pt · Esc: Select')).toBeVisible(), {
      timeout: 3000,
    });
    penSession().pressureSeen = true;
    window.dispatchEvent(new PointerEvent('pointerup'));
    await userEvent.click(black);
    const editor = await screen.findByTestId('pen-preset-editor');
    expect(within(editor).getByTestId('pen-editor-width-note').textContent).toMatch(
      /Viewers that redraw ink themselves show it at one width/,
    );
  });

  it('the preset ring shows only while the pen is armed, not with another Draw tool', () => {
    render(<Harness />);
    const ringOf = (el: HTMLElement) => getComputedStyle(el, '::before').borderTopColor;
    act(() => useToolStore.getState().setMode('ink'));
    const armed = dot('Black pen, 1.5 pt');
    expect(armed).toHaveAttribute('data-armed');
    expect(ringOf(armed)).not.toBe('rgba(0, 0, 0, 0)');
    for (const mode of ['eraser', 'lasso', 'rectangle', 'arrow'] as const) {
      act(() => useToolStore.getState().setMode(mode));
      const radios = within(presets()).getAllByRole('radio');
      expect(
        radios.filter((r) => r.hasAttribute('data-armed')),
        mode,
      ).toEqual([]);
      for (const radio of radios) expect(ringOf(radio), mode).toBe('rgba(0, 0, 0, 0)');
      // The armed preset is still the pen's (the radio), only its ring is gone.
      expect(dot('Black pen, 1.5 pt')).toHaveAttribute('aria-checked', 'true');
    }
  });

  it('the tier shows the variable-width note only once a pen with pressure was seen', async () => {
    render(<Harness />);
    expect(screen.getByTestId('tier')).toBeEmptyDOMElement();
    penSession().pressureSeen = true;
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(
      await within(screen.getByTestId('tier')).findByText(
        "Width changes are stored in the stroke's appearance. Viewers that redraw ink themselves show it at one width.",
      ),
    ).toBeVisible();
  });
});
