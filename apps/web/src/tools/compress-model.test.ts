import type { CompressionAnalysis, CompressionResult, ImageInfo } from '@pdf-editor/engine';
import {
  COMPRESSION_PRESETS,
  estimateCompression,
  planImage,
  presetSettings,
  targetSize,
} from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import {
  type CompressState,
  compressReducer,
  currentEstimate,
  deltaPercent,
  INITIAL_COMPRESS_STATE,
  progressShare,
} from './compress-model';

const image = (overrides: Partial<ImageInfo> = {}): ImageInfo => ({
  ref: '5 0',
  page: 0,
  width: 2400,
  height: 1800,
  colorSpace: 'DeviceRGB',
  components: 3,
  bitsPerComponent: 8,
  filter: 'FlateDecode',
  filters: ['FlateDecode'],
  hasSMask: false,
  hasMask: false,
  imageMask: false,
  bytes: 4_000_000,
  dpi: { x: 600, y: 600 },
  placements: 1,
  ...overrides,
});

const analysis = (
  images: ImageInfo[],
  total = 5_000_000,
  lossless = 4_900_000,
): CompressionAnalysis => ({
  totalBytes: total,
  pageCount: 2,
  objectCount: 20,
  images,
  fonts: [],
  imageBytes: images.reduce((s, i) => s + i.bytes, 0),
  fontBytes: 0,
  losslessBytes: lossless,
  duplicateStreams: 0,
});

describe('preset math', () => {
  it('matches the spec presets', () => {
    expect(COMPRESSION_PRESETS).toEqual({
      screen: { dpi: 96, quality: 60 },
      ebook: { dpi: 150, quality: 75 },
      print: { dpi: 300, quality: 85 },
    });
    expect(presetSettings('custom', { dpi: 5000, quality: 0 })).toMatchObject({
      dpi: 1200,
      quality: 1,
    });
  });

  it('downsamples per axis only above the target (with a 10 % margin)', () => {
    expect(targetSize(image(), 150)).toEqual({ width: 600, height: 450 });
    expect(targetSize(image({ dpi: { x: 160, y: 160 } }), 150)).toEqual({
      width: 2400,
      height: 1800,
    });
    expect(targetSize(image({ dpi: { x: 300, y: 150 } }), 150)).toEqual({
      width: 1200,
      height: 1800,
    });
    expect(targetSize(image({ dpi: null }), 96)).toEqual({ width: 2400, height: 1800 });
  });

  it('applies the skip rules', () => {
    const screen = presetSettings('screen');
    const reason = (overrides: Partial<ImageInfo>) => {
      const plan = planImage(image(overrides), screen);
      return plan.action === 'skip' ? plan.reason : plan.action;
    };
    expect(reason({})).toBe('encode');
    expect(reason({ filters: ['CCITTFaxDecode'], filter: 'CCITTFaxDecode' })).toBe(
      'filter-unsupported',
    );
    expect(reason({ filters: ['JBIG2Decode'], filter: 'JBIG2Decode' })).toBe('filter-unsupported');
    expect(reason({ filters: ['JPXDecode'], filter: 'JPXDecode' })).toBe('filter-unsupported');
    expect(reason({ hasSMask: true })).toBe('has-alpha');
    expect(planImage(image({ hasSMask: true }), { ...screen, flattenAlpha: true }).action).toBe(
      'encode',
    );
    expect(reason({ imageMask: true })).toBe('image-mask');
    expect(reason({ bitsPerComponent: 1 })).toBe('bilevel');
    expect(reason({ hasMask: true })).toBe('has-mask');
    expect(reason({ width: 10 })).toBe('too-small');
    expect(reason({ bytes: 500 })).toBe('too-small');
    // A JPEG at or below the target is never re-encoded.
    expect(reason({ filter: 'DCTDecode', filters: ['DCTDecode'], dpi: { x: 90, y: 90 } })).toBe(
      'at-target',
    );
    // A Flate image at the target is still re-encoded (JPEG is usually far smaller).
    expect(reason({ dpi: { x: 90, y: 90 } })).toBe('encode');
  });

  it('estimates from the lossless size and the image model; flags < 3 %', () => {
    const big = estimateCompression(analysis([image()]), presetSettings('ebook'));
    expect(big.losslessSaved).toBe(100_000);
    expect(big.imagesSaved).toBeGreaterThan(3_900_000);
    expect(big.worthwhile).toBe(true);
    const lossless = estimateCompression(analysis([image()], 5_000_000, 4_950_000), {
      ...presetSettings('ebook'),
      images: false,
    });
    expect(lossless.ratio).toBeCloseTo(0.01);
    expect(lossless.worthwhile).toBe(false);
    const skipped = estimateCompression(
      analysis([image({ hasSMask: true })], 5_000_000, 4_990_000),
      presetSettings('screen'),
    );
    expect(skipped).toMatchObject({ candidates: 0, skipped: 1, worthwhile: false });
  });

  it('formats deltas and progress', () => {
    expect(deltaPercent(1000, 600)).toBe(-40);
    expect(deltaPercent(1000, 999)).toBe(-1);
    expect(deltaPercent(1000, 1000)).toBe(0);
    expect(deltaPercent(2_400_000, 11_800)).toBe(-99);
    expect(progressShare(null)).toBe(0);
    expect(progressShare({ phase: 'images', done: 1, total: 2 })).toBeCloseTo(42.5);
    expect(progressShare({ phase: 'finishing', done: 1, total: 1 })).toBe(100);
  });
});

describe('dialog state machine', () => {
  const result: CompressionResult = {
    bytes: new ArrayBuffer(8),
    before: 5_000_000,
    after: 100_000,
    losslessSaved: 100_000,
    imagesSaved: 4_800_000,
    images: [],
    pages: [
      { page: 0, before: 10, after: 9 },
      { page: 1, before: 4_000_000, after: 90_000 },
    ],
    unchanged: false,
    warnings: [],
    durationMs: 10,
  };

  it('walks analyze → choose → run → result → back', () => {
    let state: CompressState = INITIAL_COMPRESS_STATE;
    // Nothing happens before the analysis arrives.
    expect(compressReducer(state, { type: 'run' })).toBe(state);
    state = compressReducer(state, { type: 'analyzed', analysis: analysis([image()]) });
    expect(state).toMatchObject({ step: 'choose', settings: { preset: 'ebook', dpi: 150 } });
    state = compressReducer(state, { type: 'preset', preset: 'screen' });
    expect(state).toMatchObject({ settings: { preset: 'screen', dpi: 96, quality: 60 } });
    expect(currentEstimate(state)?.worthwhile).toBe(true);
    state = compressReducer(state, { type: 'custom', dpi: 20 });
    expect(state).toMatchObject({ settings: { preset: 'custom', dpi: 36, quality: 80 } });
    state = compressReducer(state, { type: 'flatten-alpha', enabled: true });
    state = compressReducer(state, { type: 'run' });
    expect(state.step).toBe('running');
    // Settings are frozen while running.
    expect(compressReducer(state, { type: 'preset', preset: 'print' })).toBe(state);
    state = compressReducer(state, {
      type: 'progress',
      progress: { phase: 'images', done: 1, total: 3 },
    });
    state = compressReducer(state, { type: 'finished', result });
    expect(state).toMatchObject({ step: 'result', compare: false, comparePage: 1 });
    state = compressReducer(state, { type: 'compare', enabled: true });
    state = compressReducer(state, { type: 'compare-page', page: 99 });
    expect(state).toMatchObject({ compare: true, comparePage: 1 });
    state = compressReducer(state, { type: 'back' });
    expect(state).toMatchObject({
      step: 'choose',
      settings: { preset: 'custom', dpi: 36, flattenAlpha: true },
    });
  });

  it('cancels and fails back to the choice', () => {
    let state = compressReducer(INITIAL_COMPRESS_STATE, {
      type: 'analyzed',
      analysis: analysis([image()]),
      initial: { ...presetSettings('custom', { dpi: 120, quality: 50 }) },
    });
    expect(state).toMatchObject({ settings: { preset: 'custom', dpi: 120 }, custom: { dpi: 120 } });
    state = compressReducer(state, { type: 'run' });
    expect(compressReducer(state, { type: 'cancel' }).step).toBe('choose');
    const failed = compressReducer(state, { type: 'failed', message: 'boom' });
    expect(failed).toMatchObject({ step: 'failed', message: 'boom' });
    expect(compressReducer(failed, { type: 'back' }).step).toBe('choose');
    const early = compressReducer(INITIAL_COMPRESS_STATE, { type: 'failed', message: 'x' });
    expect(compressReducer(early, { type: 'back' })).toBe(early);
  });
});
