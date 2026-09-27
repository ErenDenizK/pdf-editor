/**
 * The compression dialog's state machine (spec §5): analyze → choose (estimate before) →
 * run (progress) → result (actual after, compare). Pure: the dialog dispatches actions
 * and renders the state; tests drive it directly.
 */
import {
  type CompressionAnalysis,
  type CompressionEstimate,
  type CompressionPresetId,
  type CompressionProgress,
  type CompressionResult,
  type CompressionSettings,
  estimateCompression,
  MAX_DPI,
  MIN_DPI,
  presetSettings,
} from '@pdf-editor/engine';

export { deltaPercent, progressShare } from './compress-math';

export type CompressState =
  | { readonly step: 'analyzing' }
  | {
      readonly step: 'choose';
      readonly analysis: CompressionAnalysis;
      readonly settings: CompressionSettings;
      /** Custom values, kept while other presets are selected. */
      readonly custom: { readonly dpi: number; readonly quality: number };
    }
  | {
      readonly step: 'running';
      readonly analysis: CompressionAnalysis;
      readonly settings: CompressionSettings;
      readonly custom: { readonly dpi: number; readonly quality: number };
      readonly progress: CompressionProgress | null;
    }
  | {
      readonly step: 'result';
      readonly analysis: CompressionAnalysis;
      readonly settings: CompressionSettings;
      readonly custom: { readonly dpi: number; readonly quality: number };
      readonly result: CompressionResult;
      readonly compare: boolean;
      /** 0-based page shown in the comparison. */
      readonly comparePage: number;
    }
  | { readonly step: 'failed'; readonly message: string; readonly back: CompressState | null };

export type CompressAction =
  | {
      readonly type: 'analyzed';
      readonly analysis: CompressionAnalysis;
      /** Settings applied to this document's export earlier, to start from. */
      readonly initial?: CompressionSettings;
    }
  | { readonly type: 'preset'; readonly preset: CompressionPresetId }
  | { readonly type: 'custom'; readonly dpi?: number; readonly quality?: number }
  | { readonly type: 'images'; readonly enabled: boolean }
  | { readonly type: 'flatten-alpha'; readonly enabled: boolean }
  | { readonly type: 'run' }
  | { readonly type: 'progress'; readonly progress: CompressionProgress }
  | { readonly type: 'finished'; readonly result: CompressionResult }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'cancel' }
  | { readonly type: 'back' }
  | { readonly type: 'compare'; readonly enabled: boolean }
  | { readonly type: 'compare-page'; readonly page: number };

export const INITIAL_COMPRESS_STATE: CompressState = { step: 'analyzing' };

const DEFAULT_CUSTOM = { dpi: 200, quality: 80 } as const;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function withPreset(
  settings: CompressionSettings,
  preset: CompressionPresetId,
  custom: { readonly dpi: number; readonly quality: number },
): CompressionSettings {
  const base = presetSettings(preset, custom);
  return { ...settings, preset, dpi: base.dpi, quality: base.quality };
}

export function compressReducer(state: CompressState, action: CompressAction): CompressState {
  switch (action.type) {
    case 'analyzed': {
      const initial = action.initial;
      const custom =
        initial?.preset === 'custom'
          ? { dpi: initial.dpi, quality: initial.quality }
          : DEFAULT_CUSTOM;
      return {
        step: 'choose',
        analysis: action.analysis,
        settings: initial ?? presetSettings('ebook'),
        custom,
      };
    }
    case 'preset':
      if (state.step !== 'choose') return state;
      return { ...state, settings: withPreset(state.settings, action.preset, state.custom) };
    case 'custom': {
      if (state.step !== 'choose') return state;
      const custom = {
        dpi: action.dpi === undefined ? state.custom.dpi : clampInt(action.dpi, MIN_DPI, MAX_DPI),
        quality:
          action.quality === undefined ? state.custom.quality : clampInt(action.quality, 1, 100),
      };
      return { ...state, custom, settings: withPreset(state.settings, 'custom', custom) };
    }
    case 'images':
      if (state.step !== 'choose') return state;
      return { ...state, settings: { ...state.settings, images: action.enabled } };
    case 'flatten-alpha':
      if (state.step !== 'choose') return state;
      return { ...state, settings: { ...state.settings, flattenAlpha: action.enabled } };
    case 'run':
      if (state.step !== 'choose') return state;
      return { ...state, step: 'running', progress: null };
    case 'progress':
      if (state.step !== 'running') return state;
      return { ...state, progress: action.progress };
    case 'finished':
      if (state.step !== 'running') return state;
      return {
        step: 'result',
        analysis: state.analysis,
        settings: state.settings,
        custom: state.custom,
        result: action.result,
        compare: false,
        comparePage: firstChangedPage(action.result),
      };
    case 'failed':
      return {
        step: 'failed',
        message: action.message,
        back:
          state.step === 'running' ? toChoose(state) : state.step === 'analyzing' ? null : state,
      };
    case 'cancel':
      return state.step === 'running' ? toChoose(state) : state;
    case 'back':
      if (state.step === 'result') return toChoose(state);
      if (state.step === 'failed') return state.back ?? state;
      return state;
    case 'compare':
      return state.step === 'result' ? { ...state, compare: action.enabled } : state;
    case 'compare-page':
      if (state.step !== 'result') return state;
      return {
        ...state,
        comparePage: clampInt(action.page, 0, Math.max(0, state.analysis.pageCount - 1)),
      };
  }
}

function toChoose(
  state: Extract<CompressState, { step: 'running' | 'result' }>,
): Extract<CompressState, { step: 'choose' }> {
  return {
    step: 'choose',
    analysis: state.analysis,
    settings: state.settings,
    custom: state.custom,
  };
}

/** The page with the largest saving, else the first page. */
export function firstChangedPage(result: CompressionResult): number {
  let best = 0;
  let saved = 0;
  for (const page of result.pages) {
    if (page.before - page.after > saved) {
      saved = page.before - page.after;
      best = page.page;
    }
  }
  return best;
}

/** The estimate shown before running (null while analyzing). */
export function currentEstimate(state: CompressState): CompressionEstimate | null {
  return state.step === 'choose' || state.step === 'running'
    ? estimateCompression(state.analysis, state.settings)
    : null;
}
