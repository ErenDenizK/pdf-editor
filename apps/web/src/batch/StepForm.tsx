/**
 * The options form of one recipe step, generated from the step kind. The fields and their
 * words are those of the app's dialogs (furniture, resize, crop, compress, strip, password,
 * export), kept to the options a recipe stores. Values are checked when the recipe is saved
 * (`readRecipe`), which names the step and the option at fault.
 */
import {
  ANCHOR_POSITIONS,
  type Anchor,
  MAX_RECIPE_IMAGE_BYTES,
  METADATA_TEXT_FIELDS,
  PAPER_SIZES,
  type PaperSizeId,
  RECIPE_FONT_FAMILIES,
  RECIPE_DEFAULT_OCR_REPLACE,
  RECIPE_SLOTS,
  type RecipeConvertCommon,
  type RecipeOcrOptions,
  type RecipeOcrReplace,
  type RecipeFontFamily,
  type RecipePageSelection,
  type RecipeRange,
  type RecipeStep,
  type RecipeStepOf,
  type RecipeTextStyle,
  RESIZE_MODES,
  type ResizeMode,
} from '@pdf-editor/document-model';
import type { OcrLanguagePack } from '@pdf-editor/engine';
import { type ReactNode, useEffect, useId, useState } from 'react';

import { PERMISSION_KEYS, permissionLabel } from '../document/security-text';
import { STRIP_ITEMS } from '../document/strip-items';
import { getLocale, m } from '../i18n';
import { ocrDependencies } from '../ocr/ocr-deps';
import { formatMegabytes, languageName, languagesKey } from '../ocr/ocr-model';
import tool from '../tools/ToolDialog.module.css';
import styles from './Batch.module.css';
import { anchorLabel, compressPresetLabel, OCR_HIGH_DPI, OCR_STANDARD_DPI } from './labels';
import { formatRanges, parseRanges } from './step-defaults';

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function NumberField(props: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  const [shown, setShown] = useState(props.value);
  // Follow outside changes without fighting the user's typing.
  if (shown !== props.value && Number(text) !== props.value) {
    setShown(props.value);
    setText(String(props.value));
  }
  const number = Number(text);
  const invalid =
    text.trim() === '' || !Number.isFinite(number) || number < props.min || number > props.max;
  return (
    <label className={tool.field}>
      <span className={tool.label}>{props.label}</span>
      <input
        className={tool.input}
        type="number"
        inputMode="decimal"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={text}
        aria-invalid={invalid}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const value = Number(next);
          if (
            next.trim() !== '' &&
            Number.isFinite(value) &&
            value >= props.min &&
            value <= props.max
          ) {
            setShown(value);
            props.onChange(value);
          }
        }}
      />
    </label>
  );
}

function TextField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly mono?: boolean;
}) {
  return (
    <label className={tool.field}>
      <span className={tool.label}>{props.label}</span>
      <input
        className={tool.input}
        value={props.value}
        spellCheck={false}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly (readonly [T, string])[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <label className={tool.field}>
      <span className={tool.label}>{props.label}</span>
      <select
        className={tool.select}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as T)}
      >
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckField(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className={tool.check}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

function Row({ children }: { readonly children: ReactNode }) {
  return <div className={tool.row}>{children}</div>;
}

type PageMode = Extract<RecipePageSelection, string> | 'ranges';

const PAGE_MODES: readonly PageMode[] = [
  'all',
  'odd',
  'even',
  'first',
  'last',
  'landscape',
  'portrait',
  'ranges',
];

function pageModeLabel(mode: PageMode): string {
  switch (mode) {
    case 'all':
      return m.furniture_range_all();
    case 'odd':
      return m.furniture_range_odd();
    case 'even':
      return m.furniture_range_even();
    case 'first':
      return m.batch_pages_first();
    case 'last':
      return m.batch_pages_last();
    case 'landscape':
      return m.batch_pages_landscape();
    case 'portrait':
      return m.batch_pages_portrait();
    case 'ranges':
      return m.batch_pages_custom();
  }
}

/** Which pages of each file: a rule, or ranges ("1-3, 5, 7-"). */
function PagesField(props: {
  readonly value: RecipePageSelection;
  readonly onChange: (value: RecipePageSelection) => void;
  readonly exclude?: readonly PageMode[];
}) {
  const hintId = useId();
  const mode: PageMode = typeof props.value === 'string' ? props.value : 'ranges';
  const [text, setText] = useState(formatRanges(props.value) || '1');
  const parsed = parseRanges(text);
  return (
    <Row>
      <SelectField<PageMode>
        label={m.furniture_pages()}
        value={mode}
        options={PAGE_MODES.filter((p) => !props.exclude?.includes(p)).map((p) => [
          p,
          pageModeLabel(p),
        ])}
        onChange={(next) => {
          if (next !== 'ranges') props.onChange(next);
          else props.onChange({ ranges: parseRanges(text) ?? [{ from: 1, to: 1 }] });
        }}
      />
      {mode === 'ranges' ? (
        <label className={tool.field}>
          <span className={tool.label}>{m.batch_pages_ranges_label()}</span>
          <input
            className={tool.input}
            value={text}
            spellCheck={false}
            aria-invalid={parsed === undefined}
            aria-describedby={hintId}
            onChange={(event) => {
              setText(event.target.value);
              const ranges = parseRanges(event.target.value);
              if (ranges !== undefined) props.onChange({ ranges });
            }}
          />
          <span id={hintId} className={tool.hint}>
            {parsed === undefined ? m.batch_pages_ranges_invalid() : m.batch_pages_ranges_hint()}
          </span>
        </label>
      ) : null}
    </Row>
  );
}

const RANGE_MODES: readonly RecipeRange['mode'][] = ['all', 'skip-first', 'odd', 'even', 'custom'];

function rangeModeLabel(mode: RecipeRange['mode']): string {
  switch (mode) {
    case 'all':
      return m.furniture_range_all();
    case 'skip-first':
      return m.furniture_range_skip_first();
    case 'odd':
      return m.furniture_range_odd();
    case 'even':
      return m.furniture_range_even();
    case 'custom':
      return m.furniture_range_custom();
  }
}

/** Furniture page range (all, all but the first, odd, even, from–to). */
function RangeField(props: {
  readonly value: RecipeRange;
  readonly onChange: (value: RecipeRange) => void;
}) {
  const { value } = props;
  return (
    <Row>
      <SelectField<RecipeRange['mode']>
        label={m.furniture_pages()}
        value={value.mode}
        options={RANGE_MODES.map((mode) => [mode, rangeModeLabel(mode)])}
        onChange={(mode) =>
          props.onChange(mode === 'custom' ? { mode, from: 1, to: 9999 } : { mode })
        }
      />
      {value.mode === 'custom' ? (
        <>
          <NumberField
            label={m.furniture_range_from()}
            value={value.from}
            min={1}
            max={100000}
            onChange={(from) => props.onChange({ ...value, from })}
          />
          <NumberField
            label={m.furniture_range_to()}
            value={value.to}
            min={1}
            max={100000}
            onChange={(to) => props.onChange({ ...value, to })}
          />
        </>
      ) : null}
    </Row>
  );
}

function AnchorField(props: {
  readonly value: Anchor;
  readonly onChange: (value: Anchor) => void;
  readonly options?: readonly Anchor[];
}) {
  return (
    <SelectField<Anchor>
      label={m.furniture_anchor_label()}
      value={props.value}
      options={(props.options ?? ANCHOR_POSITIONS).map((a) => [a, anchorLabel(a)])}
      onChange={props.onChange}
    />
  );
}

function StyleFields(props: {
  readonly value: RecipeTextStyle;
  readonly onChange: (value: RecipeTextStyle) => void;
  readonly opacityOnly?: boolean;
}) {
  const { value } = props;
  const set = (patch: Partial<RecipeTextStyle>) => props.onChange({ ...value, ...patch });
  const opacity = (
    <NumberField
      label={m.batch_field_opacity_percent()}
      value={Math.round(value.opacity * 100)}
      min={5}
      max={100}
      onChange={(percent) => set({ opacity: percent / 100 })}
    />
  );
  if (props.opacityOnly === true) return <Row>{opacity}</Row>;
  return (
    <>
      <Row>
        <SelectField<RecipeFontFamily>
          label={m.furniture_font()}
          value={value.family}
          options={RECIPE_FONT_FAMILIES.map((f) => [f, f])}
          onChange={(family) => set({ family })}
        />
        <NumberField
          label={m.furniture_size()}
          value={value.size}
          min={4}
          max={400}
          onChange={(size) => set({ size })}
        />
        <label className={tool.field}>
          <span className={tool.label}>{m.furniture_color()}</span>
          <input
            className={tool.input}
            type="color"
            value={value.color}
            onChange={(event) => set({ color: event.target.value.toLowerCase() })}
          />
        </label>
        {opacity}
      </Row>
      <Row>
        <CheckField
          label={m.furniture_bold()}
          checked={value.bold}
          onChange={(bold) => set({ bold })}
        />
        <CheckField
          label={m.furniture_italic()}
          checked={value.italic}
          onChange={(italic) => set({ italic })}
        />
      </Row>
    </>
  );
}

function MarginFields(props: {
  readonly marginX: number;
  readonly marginY: number;
  readonly onChange: (patch: { marginX?: number; marginY?: number }) => void;
}) {
  return (
    <>
      <NumberField
        label={m.batch_field_margin_x()}
        value={props.marginX}
        min={0}
        max={500}
        onChange={(marginX) => props.onChange({ marginX })}
      />
      <NumberField
        label={m.batch_field_margin_y()}
        value={props.marginY}
        min={0}
        max={500}
        onChange={(marginY) => props.onChange({ marginY })}
      />
    </>
  );
}

function paperLabel(id: PaperSizeId | 'custom'): string {
  switch (id) {
    case 'a3':
      return 'A3';
    case 'a4':
      return 'A4';
    case 'a5':
      return 'A5';
    case 'letter':
      return m.resize_preset_letter();
    case 'legal':
      return m.resize_preset_legal();
    case 'tabloid':
      return m.resize_preset_tabloid();
    case 'custom':
      return m.resize_preset_custom();
  }
}

function modeLabel(mode: ResizeMode): string {
  switch (mode) {
    case 'scale':
      return m.resize_mode_scale();
    case 'fit':
      return m.resize_mode_fit();
    case 'canvas':
      return m.resize_mode_canvas();
  }
}

/** Standard base64 of `bytes` (the recipe embeds the watermark image). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return undefined;
}

/** The furniture tokens, passed literally (braces are placeholders in messages). */
function tokensHint(): string {
  return m.batch_tokens_hint({
    page: '{page}',
    pages: '{pages}',
    label: '{label}',
    title: '{title}',
    date: '{date}',
  });
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function StepForm({
  step,
  onChange,
}: {
  readonly step: RecipeStep;
  readonly onChange: (step: RecipeStep) => void;
}) {
  const [imageError, setImageError] = useState<string | null>(null);
  const update = <S extends RecipeStep>(current: S, patch: Partial<S['options']>) =>
    onChange({ ...current, options: { ...current.options, ...patch } } as RecipeStep);

  switch (step.kind) {
    case 'rotate':
      return (
        <>
          <Row>
            <SelectField<'1' | '2' | '3'>
              label={m.batch_field_rotation()}
              value={String(step.options.quarterTurns) as '1' | '2' | '3'}
              options={[
                ['1', m.batch_rotate_right()],
                ['2', m.batch_rotate_half()],
                ['3', m.batch_rotate_left()],
              ]}
              onChange={(turns) => update(step, { quarterTurns: Number(turns) as 1 | 2 | 3 })}
            />
          </Row>
          <PagesField value={step.options.pages} onChange={(pages) => update(step, { pages })} />
        </>
      );
    case 'delete-pages':
      return (
        <PagesField
          value={step.options.pages}
          exclude={['all']}
          onChange={(pages) => update(step, { pages })}
        />
      );
    case 'crop': {
      const margins = step.options.margins;
      const side = (key: keyof typeof margins, label: string) => (
        <NumberField
          label={label}
          value={margins[key]}
          min={0}
          max={14400}
          onChange={(value) => update(step, { margins: { ...margins, [key]: value } })}
        />
      );
      return (
        <>
          <p className={styles.muted}>{m.batch_crop_hint()}</p>
          <div className={styles.grid2}>
            {side('top', m.batch_field_top())}
            {side('right', m.batch_field_right())}
            {side('bottom', m.batch_field_bottom())}
            {side('left', m.batch_field_left())}
          </div>
          <PagesField value={step.options.pages} onChange={(pages) => update(step, { pages })} />
        </>
      );
    }
    case 'page-size': {
      const o = step.options;
      return (
        <>
          <Row>
            <SelectField<PaperSizeId | 'custom'>
              label={m.resize_preset_label()}
              value={o.preset}
              options={[...(Object.keys(PAPER_SIZES) as PaperSizeId[]), 'custom' as const].map(
                (id) => [id, paperLabel(id)],
              )}
              onChange={(preset) =>
                onChange({
                  ...step,
                  options:
                    preset === 'custom'
                      ? (({ landscape: _l, ...rest }) => ({
                          ...rest,
                          preset,
                          width: o.width ?? 595,
                          height: o.height ?? 842,
                        }))(o)
                      : (({ width: _w, height: _h, ...rest }) => ({ ...rest, preset }))(o),
                })
              }
            />
            {o.preset === 'custom' ? (
              <>
                <NumberField
                  label={m.batch_field_width_pt()}
                  value={o.width ?? 595}
                  min={3}
                  max={14400}
                  onChange={(width) => update(step, { width })}
                />
                <NumberField
                  label={m.batch_field_height_pt()}
                  value={o.height ?? 842}
                  min={3}
                  max={14400}
                  onChange={(height) => update(step, { height })}
                />
              </>
            ) : null}
            <SelectField<ResizeMode>
              label={m.resize_mode_label()}
              value={o.mode}
              options={RESIZE_MODES.map((mode) => [mode, modeLabel(mode)])}
              onChange={(mode) =>
                onChange({
                  ...step,
                  options:
                    mode === 'scale'
                      ? { ...o, mode }
                      : (({ stretch: _s, ...rest }) => ({ ...rest, mode }))(o),
                })
              }
            />
            <AnchorField value={o.anchor} onChange={(anchor) => update(step, { anchor })} />
          </Row>
          <Row>
            {o.preset !== 'custom' ? (
              <CheckField
                label={m.resize_landscape()}
                checked={o.landscape === true}
                onChange={(landscape) => update(step, { landscape })}
              />
            ) : null}
            <CheckField
              label={m.resize_match_orientation()}
              checked={o.matchOrientation === true}
              onChange={(matchOrientation) => update(step, { matchOrientation })}
            />
            {o.mode === 'scale' ? (
              <CheckField
                label={m.resize_stretch()}
                checked={o.stretch === true}
                onChange={(stretch) => update(step, { stretch })}
              />
            ) : null}
          </Row>
          <PagesField value={o.pages} onChange={(pages) => update(step, { pages })} />
        </>
      );
    }
    case 'page-numbers': {
      const o = step.options;
      return (
        <>
          <Row>
            <TextField
              label={m.furniture_template_label()}
              value={o.template}
              onChange={(template) => update(step, { template })}
            />
            <NumberField
              label={m.furniture_start_number()}
              value={o.startNumber}
              min={0}
              max={1_000_000}
              onChange={(startNumber) => update(step, { startNumber })}
            />
          </Row>
          <p className={styles.muted}>{tokensHint()}</p>
          <Row>
            <AnchorField value={o.anchor} onChange={(anchor) => update(step, { anchor })} />
            <MarginFields
              marginX={o.marginX}
              marginY={o.marginY}
              onChange={(p) => update(step, p)}
            />
          </Row>
          <StyleFields value={o.style} onChange={(style) => update(step, { style })} />
          <RangeField value={o.range} onChange={(range) => update(step, { range })} />
          <CheckField
            label={m.furniture_mirror()}
            checked={o.mirror}
            onChange={(mirror) => update(step, { mirror })}
          />
        </>
      );
    }
    case 'header-footer': {
      const o = step.options;
      return (
        <>
          <div className={styles.grid2}>
            {RECIPE_SLOTS.map((slot) => (
              <TextField
                key={slot}
                label={anchorLabel(slot)}
                value={o.slots[slot]}
                onChange={(text) => update(step, { slots: { ...o.slots, [slot]: text } })}
              />
            ))}
          </div>
          <p className={styles.muted}>{tokensHint()}</p>
          <Row>
            <MarginFields
              marginX={o.marginX}
              marginY={o.marginY}
              onChange={(p) => update(step, p)}
            />
          </Row>
          <StyleFields value={o.style} onChange={(style) => update(step, { style })} />
          <RangeField value={o.range} onChange={(range) => update(step, { range })} />
          <CheckField
            label={m.furniture_mirror()}
            checked={o.mirror}
            onChange={(mirror) => update(step, { mirror })}
          />
        </>
      );
    }
    case 'bates': {
      const o = step.options;
      return (
        <>
          <Row>
            <TextField
              label={m.furniture_bates_prefix()}
              value={o.prefix}
              onChange={(prefix) => update(step, { prefix })}
            />
            <NumberField
              label={m.furniture_bates_width()}
              value={o.width}
              min={1}
              max={12}
              onChange={(width) => update(step, { width })}
            />
            <NumberField
              label={m.furniture_start_number()}
              value={o.start}
              min={0}
              max={999_999_999_999}
              onChange={(start) => update(step, { start })}
            />
            <TextField
              label={m.furniture_bates_suffix()}
              value={o.suffix}
              onChange={(suffix) => update(step, { suffix })}
            />
          </Row>
          <Row>
            <AnchorField value={o.anchor} onChange={(anchor) => update(step, { anchor })} />
            <MarginFields
              marginX={o.marginX}
              marginY={o.marginY}
              onChange={(p) => update(step, p)}
            />
          </Row>
          <StyleFields value={o.style} onChange={(style) => update(step, { style })} />
          <CheckField
            label={m.batch_bates_continuous()}
            checked={o.continuous}
            onChange={(continuous) => update(step, { continuous })}
          />
        </>
      );
    }
    case 'watermark': {
      const o = step.options;
      const chooseImage = async (file: File | undefined) => {
        if (file === undefined) return;
        setImageError(null);
        if (file.size > MAX_RECIPE_IMAGE_BYTES) {
          setImageError(m.batch_watermark_image_too_large());
          return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const type = imageType(bytes);
        if (type === undefined) {
          setImageError(m.batch_watermark_image_type());
          return;
        }
        update(step, { image: { type, data: toBase64(bytes) } });
      };
      return (
        <>
          <Row>
            <SelectField<'text' | 'image'>
              label={m.furniture_watermark_kind()}
              value={o.mode}
              options={[
                ['text', m.furniture_text()],
                ['image', m.furniture_image()],
              ]}
              onChange={(mode) => update(step, { mode })}
            />
            {o.mode === 'text' ? (
              <TextField
                label={m.furniture_text()}
                value={o.text}
                onChange={(text) => update(step, { text })}
              />
            ) : (
              <label className={tool.field}>
                <span className={tool.label}>{m.furniture_image()}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(event) => void chooseImage(event.target.files?.[0])}
                />
                <span className={tool.hint}>
                  {o.image === undefined ? m.furniture_no_image() : m.batch_watermark_image_set()}
                </span>
              </label>
            )}
          </Row>
          {imageError === null ? null : <p className={styles.error}>{imageError}</p>}
          <StyleFields
            value={o.style}
            opacityOnly={o.mode === 'image'}
            onChange={(style) => update(step, { style })}
          />
          <Row>
            {o.mode === 'image' ? (
              <NumberField
                label={m.furniture_scale()}
                value={o.scale}
                min={0.05}
                max={4}
                step={0.05}
                onChange={(scale) => update(step, { scale })}
              />
            ) : null}
            <NumberField
              label={m.furniture_rotation()}
              value={o.rotate}
              min={-90}
              max={90}
              onChange={(rotate) => update(step, { rotate })}
            />
            <SelectField<'over' | 'behind'>
              label={m.furniture_layer()}
              value={o.layer}
              options={[
                ['over', m.furniture_layer_over()],
                ['behind', m.furniture_layer_behind()],
              ]}
              onChange={(layer) => update(step, { layer })}
            />
          </Row>
          <Row>
            <CheckField
              label={m.furniture_tile()}
              checked={o.tile}
              onChange={(tile) => update(step, { tile })}
            />
          </Row>
          <RangeField value={o.range} onChange={(range) => update(step, { range })} />
        </>
      );
    }
    case 'flatten':
      return (
        <Row>
          <CheckField
            label={m.export_flatten_annotations()}
            checked={step.options.annotations}
            onChange={(annotations) => update(step, { annotations })}
          />
          <CheckField
            label={m.export_flatten_forms()}
            checked={step.options.forms}
            onChange={(forms) => update(step, { forms })}
          />
        </Row>
      );
    case 'compress': {
      const o = step.options;
      return (
        <>
          <Row>
            <SelectField<'screen' | 'ebook' | 'print' | 'custom'>
              label={m.compress_preset_label()}
              value={o.preset}
              options={(['screen', 'ebook', 'print', 'custom'] as const).map((p) => [
                p,
                compressPresetLabel(p),
              ])}
              onChange={(preset) => {
                const { images, flattenAlpha, linearize } = o;
                const flags = {
                  images,
                  flattenAlpha,
                  ...(linearize === undefined ? {} : { linearize }),
                };
                onChange({
                  kind: 'compress',
                  options:
                    preset === 'custom'
                      ? { ...flags, preset, dpi: 150, quality: 75 }
                      : { ...flags, preset },
                });
              }}
            />
            {o.preset === 'custom' ? (
              <>
                <NumberField
                  label={m.compress_custom_dpi()}
                  value={o.dpi}
                  min={36}
                  max={1200}
                  onChange={(dpi) => update(step, { dpi })}
                />
                <NumberField
                  label={m.compress_custom_quality()}
                  value={o.quality}
                  min={1}
                  max={100}
                  onChange={(quality) => update(step, { quality })}
                />
              </>
            ) : null}
          </Row>
          <Row>
            <CheckField
              label={m.compress_images_toggle()}
              checked={o.images}
              onChange={(images) => update(step, { images })}
            />
            <CheckField
              label={m.compress_flatten_alpha()}
              checked={o.flattenAlpha}
              onChange={(flattenAlpha) => update(step, { flattenAlpha })}
            />
            <CheckField
              label={m.batch_compress_linearize()}
              checked={o.linearize === true}
              onChange={(linearize) => update(step, { linearize })}
            />
          </Row>
        </>
      );
    }
    case 'metadata-strip':
      return (
        <div className={styles.grid2}>
          {STRIP_ITEMS.map((item) => (
            <CheckField
              key={item.key}
              label={item.label()}
              checked={step.options[item.key]}
              onChange={(checked) => update(step, { [item.key]: checked })}
            />
          ))}
        </div>
      );
    case 'metadata-set':
      return <MetadataSetForm step={step} onChange={onChange} />;
    case 'security':
      return (
        <>
          <p className={styles.muted}>{m.batch_security_hint()}</p>
          <div className={styles.grid2}>
            {PERMISSION_KEYS.map((key) => (
              <CheckField
                key={key}
                label={permissionLabel(key)}
                checked={step.options.permissions[key]}
                onChange={(allowed) =>
                  update(step, { permissions: { ...step.options.permissions, [key]: allowed } })
                }
              />
            ))}
          </div>
        </>
      );
    case 'remove-password':
      return <p className={styles.muted}>{m.batch_remove_password_hint()}</p>;
    case 'ocr':
      return <OcrForm step={step} onChange={onChange} />;
    case 'export':
      return <ExportForm step={step} onChange={onChange} />;
  }
}

/** The language packs, as the OCR dialog lists them (loaded once per form). */
type PacksState = readonly OcrLanguagePack[] | 'loading' | { readonly failed: string };

function usePacks(): PacksState {
  const [packs, setPacks] = useState<PacksState>('loading');
  useEffect(() => {
    let live = true;
    ocrDependencies()
      .packs()
      .then((store) => store.list())
      .then(
        (list) => {
          if (live) setPacks(list);
        },
        (error: unknown) => {
          if (live) setPacks({ failed: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      live = false;
    };
  }, []);
  return packs;
}

type OcrQualityChoice = 'standard' | 'high' | 'custom';

/**
 * The OCR step: languages from the same pack list as the OCR dialog (size and whether each
 * is on this device), quality (Standard 300 dpi, High 400 dpi, or the recipe's own
 * resolution), the pages, and what happens to invisible text already there.
 */
function OcrForm({
  step,
  onChange,
}: {
  readonly step: RecipeStepOf<'ocr'>;
  readonly onChange: (step: RecipeStep) => void;
}) {
  const o = step.options;
  const locale = getLocale();
  const packs = usePacks();
  const failed = typeof packs === 'object' && 'failed' in packs ? packs.failed : undefined;
  const listed: readonly OcrLanguagePack[] =
    typeof packs === 'string' || 'failed' in packs ? [] : packs;
  const [custom, setCustom] = useState(o.dpi !== OCR_STANDARD_DPI && o.dpi !== OCR_HIGH_DPI);
  const quality: OcrQualityChoice = custom
    ? 'custom'
    : o.dpi === OCR_HIGH_DPI
      ? 'high'
      : 'standard';
  // The recipe's languages this device does not list (an imported pack elsewhere).
  const missing = o.languages.filter((code) => !listed.some((p) => p.code === code));
  const setOptions = (next: Partial<RecipeOcrOptions>) =>
    onChange({ kind: 'ocr', options: { ...o, ...next } });
  // As in the OCR dialog: a language ticked later comes after the others (the first leads).
  const toggle = (code: string, on: boolean) =>
    setOptions({
      languages: on
        ? [...o.languages.filter((c) => c !== code), code]
        : o.languages.filter((c) => c !== code),
    });
  return (
    <>
      <fieldset className={tool.fieldset}>
        <legend className={tool.legend}>{m.batch_field_languages()}</legend>
        {failed === undefined ? null : (
          <p className={styles.error}>{m.ocr_packs_failed({ reason: failed })}</p>
        )}
        <ul className={styles.languages} aria-label={m.batch_field_languages()}>
          {listed.map((pack) => (
            <li key={pack.code}>
              <label className={styles.language}>
                <input
                  type="checkbox"
                  checked={o.languages.includes(pack.code)}
                  onChange={(event) => toggle(pack.code, event.target.checked)}
                />
                <span className={styles.languageName}>{languageName(pack.code, locale)}</span>
                <span className={styles.languageMeta}>
                  {pack.onDevice
                    ? m.ocr_pack_on_device({ size: formatMegabytes(pack.bytes, locale) })
                    : m.ocr_pack_downloads({ size: formatMegabytes(pack.downloadBytes, locale) })}
                </span>
              </label>
            </li>
          ))}
          {packs === 'loading'
            ? null
            : missing.map((code) => (
                <li key={code}>
                  <label className={styles.language}>
                    <input
                      type="checkbox"
                      checked
                      onChange={(event) => toggle(code, event.target.checked)}
                    />
                    <span className={styles.languageName}>{languageName(code, locale)}</span>
                    <span className={styles.languageMeta}>{m.batch_ocr_language_missing()}</span>
                  </label>
                </li>
              ))}
        </ul>
        <p className={styles.muted}>
          {o.languages.length > 0
            ? m.ocr_languages_order({ languages: languagesKey(o.languages) })
            : m.ocr_languages_none()}{' '}
          {m.batch_ocr_languages_hint()}
        </p>
      </fieldset>
      <Row>
        <SelectField<OcrQualityChoice>
          label={m.batch_ocr_quality()}
          value={quality}
          options={[
            ['standard', m.batch_ocr_quality_standard()],
            ['high', m.batch_ocr_quality_high()],
            ['custom', m.batch_ocr_quality_custom()],
          ]}
          onChange={(choice) => {
            setCustom(choice === 'custom');
            if (choice === 'standard') setOptions({ dpi: OCR_STANDARD_DPI });
            if (choice === 'high') setOptions({ dpi: OCR_HIGH_DPI });
          }}
        />
        {custom ? (
          <NumberField
            label={m.batch_field_dpi()}
            value={o.dpi}
            min={200}
            max={400}
            onChange={(dpi) => setOptions({ dpi })}
          />
        ) : null}
      </Row>
      <Row>
        <SelectField<RecipeOcrOptions['scope']>
          label={m.furniture_pages()}
          value={o.scope}
          options={[
            ['without-text', m.batch_ocr_scope_without_text()],
            ['all', m.furniture_range_all()],
          ]}
          onChange={(scope) => setOptions({ scope })}
        />
        <SelectField<RecipeOcrReplace>
          label={m.batch_ocr_replace()}
          value={o.replace ?? RECIPE_DEFAULT_OCR_REPLACE}
          options={[
            ['ours', m.batch_ocr_replace_ours()],
            ['all-invisible', m.batch_ocr_replace_all()],
            ['none', m.batch_ocr_replace_none()],
          ]}
          onChange={(replace) => {
            // The default stays out of the file (recipes written before the option read
            // the same).
            const { replace: _previous, ...rest } = o;
            onChange({
              kind: 'ocr',
              options: replace === RECIPE_DEFAULT_OCR_REPLACE ? rest : { ...rest, replace },
            });
          }}
        />
      </Row>
    </>
  );
}

type FieldMode = 'keep' | 'set' | 'remove';
type MetadataField = (typeof METADATA_TEXT_FIELDS)[number];

function MetadataSetForm({
  step,
  onChange,
}: {
  readonly step: RecipeStepOf<'metadata-set'>;
  readonly onChange: (step: RecipeStep) => void;
}) {
  const o = step.options;
  const labels: Record<MetadataField, () => string> = {
    title: m.meta_title,
    author: m.meta_author,
    subject: m.meta_subject,
    keywords: m.meta_keywords,
    creator: m.meta_creator,
    language: m.meta_language,
  };
  // "Set" with nothing typed yet leaves the field alone in the recipe (a blank would remove
  // it), so the chosen modes are kept here.
  const [modes, setModes] = useState<Record<MetadataField, FieldMode>>(() => {
    const initial = {} as Record<MetadataField, FieldMode>;
    for (const field of METADATA_TEXT_FIELDS) {
      const value = o[field];
      initial[field] = !Object.hasOwn(o, field)
        ? 'keep'
        : value === null || value === undefined || value.trim() === ''
          ? 'remove'
          : 'set';
    }
    return initial;
  });
  const put = (field: MetadataField, next: string | null | undefined) => {
    const { [field]: _old, ...rest } = o;
    onChange({
      kind: 'metadata-set',
      options: next === undefined ? rest : { ...rest, [field]: next },
    });
  };
  return (
    <div className={styles.grid2}>
      {METADATA_TEXT_FIELDS.map((field) => {
        const mode = modes[field];
        const value = o[field];
        return (
          <div key={field} className={tool.field}>
            <SelectField<FieldMode>
              label={labels[field]()}
              value={mode}
              options={[
                ['keep', m.batch_meta_keep()],
                ['set', m.batch_meta_set()],
                ['remove', m.batch_meta_remove()],
              ]}
              onChange={(next) => {
                setModes({ ...modes, [field]: next });
                if (next === 'keep') put(field, undefined);
                else if (next === 'remove') put(field, null);
                else
                  put(field, typeof value === 'string' && value.trim() !== '' ? value : undefined);
              }}
            />
            {mode === 'set' ? (
              <input
                className={tool.input}
                aria-label={labels[field]()}
                value={value ?? ''}
                onChange={(event) =>
                  put(field, event.target.value.trim() === '' ? undefined : event.target.value)
                }
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The options Markdown and text outputs share (kept when switching between them). */
function convertCommon(o: RecipeConvertCommon): RecipeConvertCommon {
  return {
    ...(o.pageBreaks === undefined ? {} : { pageBreaks: o.pageBreaks }),
    ...(o.keepHeadersFooters === undefined ? {} : { keepHeadersFooters: o.keepHeadersFooters }),
    ...(o.joinHyphens === undefined ? {} : { joinHyphens: o.joinHyphens }),
  };
}

function ExportForm({
  step,
  onChange,
}: {
  readonly step: RecipeStepOf<'export'>;
  readonly onChange: (step: RecipeStep) => void;
}) {
  const o = step.options;
  const set = (options: RecipeStepOf<'export'>['options']) => onChange({ kind: 'export', options });
  return (
    <>
      <Row>
        <SelectField<'pdf' | 'images' | 'markdown' | 'text'>
          label={m.batch_field_output()}
          value={o.format}
          options={[
            ['pdf', m.batch_output_pdf()],
            ['images', m.batch_output_images()],
            ['markdown', m.batch_output_markdown()],
            ['text', m.batch_output_text()],
          ]}
          onChange={(format) =>
            set(
              format === 'pdf'
                ? { format }
                : format === 'images'
                  ? { format, imageFormat: 'png', dpi: 150, quality: 90, background: 'white' }
                  : // Markdown ↔ text keeps the shared options; only Markdown has images.
                    {
                      format,
                      ...(o.format === 'markdown' || o.format === 'text' ? convertCommon(o) : {}),
                    },
            )
          }
        />
      </Row>
      {o.format === 'pdf' ? (
        <Row>
          <CheckField
            label={m.export_compatibility()}
            checked={o.compatibility === true}
            onChange={(compatibility) => set({ ...o, compatibility })}
          />
          <CheckField
            label={m.export_include_comments()}
            checked={o.includeComments !== false}
            onChange={(includeComments) => set({ ...o, includeComments })}
          />
        </Row>
      ) : null}
      {o.format === 'images' ? (
        <Row>
          <SelectField<'png' | 'jpeg' | 'webp'>
            label={m.images_format()}
            value={o.imageFormat}
            options={[
              ['png', 'PNG'],
              ['jpeg', 'JPEG'],
              ['webp', 'WebP'],
            ]}
            onChange={(imageFormat) => set({ ...o, imageFormat })}
          />
          <NumberField
            label={m.batch_field_dpi()}
            value={o.dpi}
            min={18}
            max={1200}
            onChange={(dpi) => set({ ...o, dpi })}
          />
          {o.imageFormat !== 'png' ? (
            <NumberField
              label={m.images_quality()}
              value={o.quality}
              min={1}
              max={100}
              onChange={(quality) => set({ ...o, quality })}
            />
          ) : null}
          {o.imageFormat !== 'jpeg' ? (
            <SelectField<'white' | 'transparent'>
              label={m.images_background()}
              value={o.background}
              options={[
                ['white', m.images_background_white()],
                ['transparent', m.images_background_transparent()],
              ]}
              onChange={(background) => set({ ...o, background })}
            />
          ) : null}
        </Row>
      ) : null}
      {o.format === 'markdown' || o.format === 'text' ? (
        <>
          <Row>
            <SelectField<'none' | 'rule' | 'comment'>
              label={m.convert_page_breaks()}
              value={o.pageBreaks ?? 'none'}
              options={[
                ['none', m.convert_break_none()],
                ['rule', m.convert_break_rule()],
                ['comment', m.convert_break_comment()],
              ]}
              onChange={(pageBreaks) => set({ ...o, pageBreaks })}
            />
          </Row>
          <Row>
            <CheckField
              label={m.convert_keep_headers()}
              checked={o.keepHeadersFooters === true}
              onChange={(keepHeadersFooters) => set({ ...o, keepHeadersFooters })}
            />
            <CheckField
              label={m.convert_join_hyphens()}
              checked={o.joinHyphens !== false}
              onChange={(joinHyphens) => set({ ...o, joinHyphens })}
            />
          </Row>
          {o.format === 'markdown' ? (
            <Row>
              <SelectField<'include' | 'omit'>
                label={m.convert_images()}
                value={o.images === false ? 'omit' : 'include'}
                options={[
                  ['include', m.convert_images_zip()],
                  ['omit', m.convert_images_omit()],
                ]}
                onChange={(choice) => set({ ...o, images: choice === 'include' })}
              />
            </Row>
          ) : null}
        </>
      ) : null}
    </>
  );
}
