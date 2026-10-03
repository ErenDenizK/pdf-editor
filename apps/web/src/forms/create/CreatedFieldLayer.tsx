/**
 * Created form fields on a page (spec redaction-and-text-editing §3), a page overlay
 * registered after the form layer, on every kind of page (source, blank, image).
 *
 * PDFium does not know these fields (they become AcroForm fields at export), so the layer
 * draws them itself the way the export's appearance streams look (`FieldLook`: border,
 * background, value, check mark, radio dot, list selection, button label, signature
 * line), upright on the displayed page as /MK /R makes them in the output.
 *
 * Three modes:
 * - Fill (Select tool): the same hit targets and in-place editors as source fields
 *   (`FieldWidget` from the form layer); values go to the model ("Fill Name").
 * - Edit fields (design): the layer takes the page; a press selects a created widget and
 *   drags it, the handles resize it, arrows nudge it (Shift: 10 pt), Delete removes it,
 *   Mod+D duplicates it, Enter opens its properties, Esc deselects. A press on empty page
 *   deselects.
 * - Placing ("Add field" in the Forms panel): a click places the kind at its default size,
 *   a drag draws its box. Esc cancels (create/index.ts). From the keyboard the current
 *   page's layer takes the focus (create/index.ts): Enter or Space places the field at its
 *   default size in the centre of the visible part of the page, arrows move it first
 *   (Shift: 10 pt; it is drawn while the layer has the keyboard focus). The new field then
 *   takes the focus, selected in Edit fields.
 *
 * Geometry goes through the viewer's page frame (rotation, CropBox, resize), and every
 * rect is clamped into the page's visible box.
 */
import {
  type CreatedField,
  type CreatedFieldKind,
  DEFAULT_FIELD_SIZE,
  FIELD_BORDER_WIDTH,
  FIELD_COLORS,
  type FieldColor,
  type FieldId,
  fieldFontSize,
  findPageLocation,
  MIN_FIELD_SIDE,
  type Rect,
} from '@pdf-editor/document-model';
import { SlidersHorizontal } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { m } from '../../i18n';
import type { PageOverlayProps } from '../../stage/page-overlays';
import { useUiStore } from '../../state/ui-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import {
  type Box,
  displayedSize,
  displayRectToUser,
  type PageFrame,
  userRectToCss,
} from '../../viewer/geometry';
import { pageContentBox, pageFrame } from '../../viewer/page-frame';
import { useToolStore } from '../../viewer/tool-store';
import { type ActiveField, useFormStore } from '../form-store';
import { FieldWidget } from '../FormLayer';
import formStyles from '../FormLayer.module.css';
import { useCreateStore } from './create-store';
import styles from './CreatedFields.module.css';
import { addField, deleteField, duplicateField, kindName, placeWidget } from './field-actions';
import { asFormField } from './field-model';
import { FieldProperties } from './FieldProperties';

/** Smallest pointer travel (CSS px) that counts as a drag. */
const DRAG_THRESHOLD = 4;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];

interface Placed {
  readonly field: CreatedField;
  readonly widget: number;
  readonly rect: Rect;
}

type Gesture =
  | {
      readonly type: 'place';
      readonly start: { x: number; y: number };
      readonly current: { x: number; y: number };
    }
  | {
      readonly type: 'move' | 'resize';
      readonly field: CreatedField;
      readonly widget: number;
      readonly handle?: Handle;
      readonly start: { x: number; y: number };
      readonly box: Box;
      readonly rect: Rect;
      readonly moved: boolean;
    };

/** A CSS-pixel box on the displayed page → a user-space rect. */
function cssToUser(frame: PageFrame, box: Box): Rect {
  const s = frame.scale;
  return displayRectToUser(frame, {
    left: box.left / s,
    top: box.top / s,
    width: box.width / s,
    height: box.height / s,
  });
}

function round(rect: Rect): Rect {
  const q = (v: number) => Math.round(v * 100) / 100;
  return { x: q(rect.x), y: q(rect.y), width: q(rect.width), height: q(rect.height) };
}

/** The page's visible box in user space, where created widgets may lie. */
function pageBounds(props: PageOverlayProps, frame: PageFrame): Rect {
  const content = pageContentBox(props.page, props.sourceId, props.sourceIndex);
  const shown = displayRectToUser(frame, { left: 0, top: 0, ...displayedSize(frame) });
  const x = Math.max(content.x, shown.x);
  const y = Math.max(content.y, shown.y);
  const right = Math.min(content.x + content.width, shown.x + shown.width);
  const top = Math.min(content.y + content.height, shown.y + shown.height);
  return right > x && top > y ? { x, y, width: right - x, height: top - y } : content;
}

/** `rect` inside `bounds`: no larger than them, slid in when it sticks out. */
function clampInto(rect: Rect, bounds: Rect): Rect {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return round({
    width,
    height,
    x: Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width - width),
    y: Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height - height),
  });
}

/** Arrow key → step direction on the displayed page. */
const ARROW_STEPS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function boxFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** `box` resized by dragging `handle` by (dx, dy) CSS px, at least `min` px each way. */
function resizeBox(box: Box, handle: Handle, dx: number, dy: number, min: number): Box {
  let { left, top, width, height } = box;
  if (handle.includes('e')) width = Math.max(min, width + dx);
  if (handle.includes('s')) height = Math.max(min, height + dy);
  if (handle.includes('w')) {
    const w = Math.max(min, width - dx);
    left += width - w;
    width = w;
  }
  if (handle.includes('n')) {
    const h = Math.max(min, height - dy);
    top += height - h;
    height = h;
  }
  return { left, top, width, height };
}

function colorCss(key: FieldColor): string | undefined {
  const c = FIELD_COLORS[key];
  return c ? `rgb(${c.r * 255} ${c.g * 255} ${c.b * 255})` : undefined;
}

export function CreatedFieldLayer(props: PageOverlayProps) {
  const { pageId, pageIndex } = props;
  const ws = useWorkspaceStore((s) => s.workspace);
  const mode = useToolStore((s) => s.mode);
  const viewMode = useUiStore((s) => s.viewMode);
  const placing = useCreateStore((s) => s.placing);
  const design = useCreateStore((s) => s.design);
  const selected = useCreateStore((s) => s.selected);
  const highlight = useFormStore((s) => s.highlight);
  const active = useFormStore((s) =>
    s.active?.pageId === pageId && s.active.fieldId !== undefined ? s.active : null,
  );
  const [gesture, setGesture] = useState<Gesture | null>(null);
  /** The field placed from the keyboard, before Enter (drawn while the layer has focus). */
  const [pending, setPending] = useState<{ kind: CreatedFieldKind; rect: Rect } | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  /** A field placed here: it takes the focus once Edit fields shows it. */
  const focusPlaced = useRef<FieldId | null>(null);
  const keysId = useId();

  const location = findPageLocation(ws, pageId);
  const doc = location ? ws.documents[location.document] : undefined;
  const placed: Placed[] = [];
  for (const field of doc?.fields ?? []) {
    field.widgets.forEach((w, widget) => {
      if (w.page === pageId) placed.push({ field, widget, rect: w.rect });
    });
  }
  const live = mode === 'select' && viewMode === 'read';
  const isPlacing = placing !== null && live;
  const isDesign = design && live && !isPlacing;

  // A selection whose field went away (undo, page deleted) is dropped.
  const selectedHere = selected
    ? placed.find((p) => p.field.id === selected.fieldId && p.widget === selected.widget)
    : undefined;
  useEffect(() => {
    if (!selected) return;
    const exists = Object.values(ws.documents).some((d) =>
      d?.fields?.some((f) => f.id === selected.fieldId && f.widgets[selected.widget]),
    );
    if (!exists) useCreateStore.getState().select(null);
  }, [ws, selected]);

  // The field just placed takes the focus (keyboard users continue on it).
  useEffect(() => {
    const id = focusPlaced.current;
    if (!id || !isDesign) return;
    focusPlaced.current = null;
    layerRef.current
      ?.querySelector<HTMLElement>(`[data-created-field-id="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: true });
  });

  if (placed.length === 0 && !isPlacing && !isDesign) return null;
  const frame = pageFrame(props);
  const bounds = pageBounds(props, frame);

  /** Pointer position in CSS px of the displayed page (the layer covers the page). */
  const localTo = (element: Element) => {
    const root = element.closest('[data-created-field-layer]') ?? element;
    const r = root.getBoundingClientRect();
    return (event: { clientX: number; clientY: number }) => ({
      x: event.clientX - r.left,
      y: event.clientY - r.top,
    });
  };

  /** Where a move / resize gesture puts the widget now (user space, clamped). */
  const gestureRect = (
    g: Extract<Gesture, { type: 'move' | 'resize' }>,
    p: { x: number; y: number },
  ) => {
    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    const box =
      g.type === 'move'
        ? { ...g.box, left: g.box.left + dx, top: g.box.top + dy }
        : resizeBox(g.box, g.handle ?? 'se', dx, dy, MIN_FIELD_SIDE * frame.scale);
    const rect = cssToUser(frame, box);
    if (g.type === 'move') {
      // Keep the size; slide inside the page.
      const x = Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width - rect.width);
      const y = Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height - rect.height);
      return round({ ...rect, x, y });
    }
    const x = Math.max(rect.x, bounds.x);
    const y = Math.max(rect.y, bounds.y);
    return round({
      x,
      y,
      width: Math.min(rect.x + rect.width, bounds.x + bounds.width) - x,
      height: Math.min(rect.y + rect.height, bounds.y + bounds.height) - y,
    });
  };

  /**
   * Follows a gesture on the window until the pointer is released; the gesture lives in
   * this closure (state only mirrors it for drawing).
   */
  const track = (
    initial: Gesture,
    local: (event: { clientX: number; clientY: number }) => { x: number; y: number },
    onEnd: (g: Gesture) => void,
  ) => {
    let current = initial;
    setGesture(current);
    const follow = (e: PointerEvent) => {
      const p = local(e);
      const g = current;
      if (g.type === 'place') current = { ...g, current: p };
      else {
        const moved = g.moved || Math.hypot(p.x - g.start.x, p.y - g.start.y) >= DRAG_THRESHOLD;
        current = { ...g, moved, rect: moved ? gestureRect(g, p) : g.rect };
      }
      setGesture(current);
    };
    const stop = () => {
      window.removeEventListener('pointermove', follow);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
    };
    const end = (e: PointerEvent) => {
      stop();
      follow(e);
      setGesture(null);
      onEnd(current);
    };
    const cancel = () => {
      stop();
      setGesture(null);
    };
    window.addEventListener('pointermove', follow);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
  };

  /** Adds the field; it takes the focus once shown in Edit fields. */
  const place = (kind: CreatedFieldKind, rect: Rect) => {
    setPending(null);
    useCreateStore.getState().setPlacing(null);
    focusPlaced.current = addField(kind, pageId, rect) ?? null;
  };

  /**
   * The kind's default size, upright, in the centre of the page's part in the free rectangle
   * of the viewport (inside its scroll padding: the stage runs under the docked panels).
   */
  const centredRect = (kind: CreatedFieldKind): Rect => {
    const s = frame.scale;
    // The displayed page, CSS px from its top left, and its part inside the scroll view.
    const shown = displayedSize(frame);
    const width = shown.width * s;
    const height = shown.height * s;
    let cx = width / 2;
    let cy = height / 2;
    const origin = layerRef.current?.getBoundingClientRect();
    const view = freeRect(layerRef.current?.closest('[data-read-viewport]'));
    if (origin && view) {
      const left = Math.max(0, view.left - origin.left);
      const right = Math.min(width, view.right - origin.left);
      const top = Math.max(0, view.top - origin.top);
      const bottom = Math.min(height, view.bottom - origin.top);
      if (right > left) cx = (left + right) / 2;
      if (bottom > top) cy = (top + bottom) / 2;
    }
    const size = DEFAULT_FIELD_SIZE[kind];
    const box = {
      left: cx - (size.width * s) / 2,
      top: cy - (size.height * s) / 2,
      width: size.width * s,
      height: size.height * s,
    };
    return clampInto(cssToUser(frame, box), bounds);
  };

  const pendingRect = (kind: CreatedFieldKind): Rect =>
    pending?.kind === kind ? pending.rect : centredRect(kind);

  const onPlacingKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isPlacing || !placing || event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = ARROW_STEPS[event.key];
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      place(placing, pendingRect(placing));
    } else if (step) {
      event.preventDefault();
      event.stopPropagation();
      const d = (event.shiftKey ? 10 : 1) * frame.scale;
      const box = userRectToCss(frame, pendingRect(placing));
      const rect = cssToUser(frame, {
        ...box,
        left: box.left + step[0] * d,
        top: box.top + step[1] * d,
      });
      setPending({ kind: placing, rect: clampInto(rect, bounds) });
    }
  };

  const onLayerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (isPlacing && placing) {
      event.preventDefault();
      event.stopPropagation();
      const local = localTo(event.currentTarget);
      const start = local(event);
      track({ type: 'place', start, current: start }, local, (g) => {
        if (g.type !== 'place') return;
        const p = g.current;
        const dragged = Math.hypot(p.x - g.start.x, p.y - g.start.y) >= DRAG_THRESHOLD;
        const s = frame.scale;
        let box: Box;
        if (dragged) {
          box = boxFromPoints(g.start, p);
        } else {
          // Default size as seen upright, centred on the click.
          const size = DEFAULT_FIELD_SIZE[placing];
          box = {
            left: g.start.x - (size.width * s) / 2,
            top: g.start.y - (size.height * s) / 2,
            width: size.width * s,
            height: size.height * s,
          };
        }
        const min = 8 * s;
        box = {
          left: box.left,
          top: box.top,
          width: Math.max(min, box.width),
          height: Math.max(min, box.height),
        };
        place(placing, clampInto(cssToUser(frame, box), bounds));
      });
      return;
    }
    if (isDesign && event.target === event.currentTarget) {
      // A press on the page itself (not on a field) deselects.
      useCreateStore.getState().select(null);
    }
  };

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    p: Placed,
    type: 'move' | 'resize',
    handle?: Handle,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const store = useCreateStore.getState();
    if (store.selected?.fieldId !== p.field.id || store.selected.widget !== p.widget) {
      store.select({ fieldId: p.field.id, widget: p.widget });
    }
    event.currentTarget.closest<HTMLElement>('[data-created-design]')?.focus({
      preventScroll: true,
    });
    const local = localTo(event.currentTarget);
    track(
      {
        type,
        field: p.field,
        widget: p.widget,
        ...(handle ? { handle } : {}),
        start: local(event),
        box: userRectToCss(frame, p.rect),
        rect: p.rect,
        moved: false,
      },
      local,
      (g) => {
        if (g.type === 'place' || !g.moved) return;
        placeWidget(g.field.id, g.widget, g.rect, bounds, g.type);
      },
    );
  };

  const onDesignKey = (event: ReactKeyboardEvent<HTMLElement>, p: Placed) => {
    const mod = event.metaKey || event.ctrlKey;
    const step = ARROW_STEPS[event.key];
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (step) {
      handled();
      const d = (event.shiftKey ? 10 : 1) * frame.scale;
      const box = userRectToCss(frame, p.rect);
      const rect = cssToUser(frame, {
        ...box,
        left: box.left + step[0] * d,
        top: box.top + step[1] * d,
      });
      placeWidget(
        p.field.id,
        p.widget,
        round(rect),
        bounds,
        'move',
        `nudge:${p.field.id}:${p.widget}`,
      );
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      handled();
      deleteField(p.field.id);
    } else if (mod && event.key.toLowerCase() === 'd') {
      handled();
      duplicateField(p.field.id, bounds);
    } else if (event.key === 'Enter' || event.key === ' ') {
      handled();
      useCreateStore.getState().select({ fieldId: p.field.id, widget: p.widget });
      useCreateStore.getState().setPropertiesOpen(true);
    } else if (event.key === 'Escape') {
      handled();
      useCreateStore.getState().select(null);
      event.currentTarget.blur();
    }
  };

  const preview =
    gesture?.type === 'place'
      ? boxFromPoints(gesture.start, gesture.current)
      : isPlacing && pending?.kind === placing
        ? userRectToCss(frame, pending.rect)
        : null;
  const dragging = gesture && gesture.type !== 'place' && gesture.moved ? gesture : null;
  const rectOf = (p: Placed) =>
    dragging?.field.id === p.field.id && dragging.widget === p.widget ? dragging.rect : p.rect;

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      data-created-field-layer={pageIndex}
      data-design={isDesign || undefined}
      data-placing={isPlacing || undefined}
      role={isPlacing ? 'application' : undefined}
      aria-label={
        isPlacing && placing
          ? m.forms_create_placing_layer({ kind: kindName(placing), page: pageIndex + 1 })
          : undefined
      }
      aria-describedby={isPlacing ? keysId : undefined}
      tabIndex={isPlacing ? 0 : undefined}
      onPointerDown={onLayerPointerDown}
      onKeyDown={onPlacingKey}
      onFocus={(event) => {
        // Keyboard focus shows where Enter will place the field.
        if (!isPlacing || !placing || event.target !== event.currentTarget) return;
        if (event.currentTarget.matches(':focus-visible') && pending?.kind !== placing) {
          setPending({ kind: placing, rect: centredRect(placing) });
        }
      }}
      onBlur={(event) => {
        if (event.target === event.currentTarget) setPending(null);
      }}
    >
      {isPlacing ? (
        <span id={keysId} className="visually-hidden">
          {m.forms_create_placing_keys()}
        </span>
      ) : null}
      {placed.map((p) => (
        <FieldLook
          key={`${p.field.id}#${p.widget}`}
          field={p.field}
          widget={p.widget}
          box={userRectToCss(frame, rectOf(p))}
          frame={frame}
          hidden={
            !isDesign &&
            active !== null &&
            active.fieldId === p.field.id &&
            active.widget === p.widget &&
            (p.field.kind === 'text' || p.field.kind === 'dropdown' || p.field.kind === 'listbox')
          }
        />
      ))}
      {live && !isDesign && !isPlacing && placed.length > 0 ? (
        <div
          className={formStyles.layer}
          data-live=""
          data-highlight={highlight || undefined}
          role="group"
          aria-label={m.forms_create_layer_label({ page: pageIndex + 1 })}
        >
          {placed.map((p) => {
            const here: ActiveField = {
              fieldId: p.field.id,
              name: p.field.name,
              widget: p.widget,
              pageId,
            };
            const field = asFormField(p.field, pageIndex);
            const isActive =
              active !== null && active.fieldId === p.field.id && active.widget === p.widget;
            return (
              <FieldWidget
                key={`${p.field.id}#${p.widget}`}
                placed={{
                  field,
                  widget: p.widget,
                  box: userRectToCss(frame, p.rect),
                  exportValue: p.field.widgets[p.widget]?.exportValue,
                }}
                frame={frame}
                here={here}
                active={isActive}
                live
                placeholder={p.field.kind === 'signature'}
              />
            );
          })}
        </div>
      ) : null}
      {isDesign
        ? placed.map((p) => {
            const box = userRectToCss(frame, rectOf(p));
            const isSelected = selectedHere === p;
            return (
              <div
                key={`design:${p.field.id}#${p.widget}`}
                data-created-design={p.field.name}
                data-created-kind={p.field.kind}
                data-created-field-id={p.field.id}
                className={styles.design}
                style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={m.forms_create_widget_label({
                  name: p.field.name,
                  kind: kindName(p.field.kind),
                })}
                aria-keyshortcuts="Enter Delete ArrowLeft ArrowRight ArrowUp ArrowDown"
                onPointerDown={(e) => startDrag(e, p, 'move')}
                onFocus={() => {
                  const s = useCreateStore.getState().selected;
                  if (s?.fieldId !== p.field.id || s.widget !== p.widget) {
                    useCreateStore.getState().select({ fieldId: p.field.id, widget: p.widget });
                  }
                }}
                onDoubleClick={() => useCreateStore.getState().setPropertiesOpen(true)}
                onKeyDown={(e) => onDesignKey(e, p)}
              >
                {isSelected
                  ? HANDLES.map((h) => (
                      <span
                        key={h}
                        className={styles.handle}
                        data-handle={h}
                        aria-hidden="true"
                        style={handleStyle(h)}
                        onPointerDown={(e) => startDrag(e, p, 'resize', h)}
                      />
                    ))
                  : null}
              </div>
            );
          })
        : null}
      {isDesign && selectedHere ? (
        <FieldProperties
          key={`${selectedHere.field.id}#${selectedHere.widget}`}
          field={selectedHere.field}
          widget={selectedHere.widget}
          bounds={bounds}
          trigger={
            <button
              type="button"
              className={styles.propertiesButton}
              style={propertiesButtonStyle(userRectToCss(frame, rectOf(selectedHere)))}
              aria-label={m.forms_create_properties()}
              data-created-properties=""
              onPointerDown={(e) => e.stopPropagation()}
            >
              <SlidersHorizontal aria-hidden="true" />
            </button>
          }
        />
      ) : null}
      {preview ? (
        <div
          className={styles.preview}
          data-created-pending={gesture?.type === 'place' ? undefined : ''}
          style={{
            left: preview.left,
            top: preview.top,
            width: preview.width,
            height: preview.height,
          }}
        />
      ) : null}
    </div>
  );
}

CreatedFieldLayer.displayName = 'CreatedFieldLayer';

function handleStyle(handle: Handle): CSSProperties {
  const x = handle.includes('w') ? '0%' : handle.includes('e') ? '100%' : '50%';
  const y = handle.includes('n') ? '0%' : handle.includes('s') ? '100%' : '50%';
  return { left: x, top: y };
}

/** The properties button sits just outside the widget's top-right corner. */
function propertiesButtonStyle(box: Box): CSSProperties {
  return { left: box.left + box.width + 6, top: box.top - 2 };
}

/** One widget drawn as the export's appearance stream looks. */
function FieldLook({
  field,
  widget,
  box,
  frame,
  hidden,
}: {
  readonly field: CreatedField;
  readonly widget: number;
  readonly box: Box;
  readonly frame: PageFrame;
  readonly hidden: boolean;
}) {
  const quarter = frame.rotation === 90 || frame.rotation === 270;
  const uprightHeight = (quarter ? box.width : box.height) / frame.scale;
  const border = colorCss(field.border);
  const borderPx = border ? FIELD_BORDER_WIDTH * frame.scale : 0;
  const fontPx = fieldFontSize(field, uprightHeight) * frame.scale;
  const padding = borderPx + frame.scale;
  const style: CSSProperties = {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    background: colorCss(field.background),
    ...(border ? { border: `${borderPx}px solid ${border}` } : {}),
    ...(field.kind === 'radio' ? { borderRadius: '50%' } : {}),
    visibility: hidden ? 'hidden' : undefined,
  };
  const align =
    field.align === 'center' ? 'center' : field.align === 'right' ? 'flex-end' : 'flex-start';
  const text = (value: string, multiline = false) => (
    <span
      className={styles.lookText}
      data-multiline={multiline || undefined}
      style={{
        fontSize: fontPx,
        lineHeight: multiline ? 1.2 : undefined,
        justifyContent: align,
        textAlign: field.align,
        padding: multiline ? padding : `0 ${padding}px`,
      }}
    >
      {value}
    </span>
  );
  let content: ReactNode;
  switch (field.kind) {
    case 'text': {
      const value = typeof field.value === 'string' ? field.value : '';
      if (field.comb && field.maxLength) {
        const cells = Array.from(value).slice(0, field.maxLength);
        content = (
          <span
            className={styles.comb}
            style={{ gridTemplateColumns: `repeat(${field.maxLength}, 1fr)`, fontSize: fontPx }}
          >
            {Array.from({ length: field.maxLength }, (_, i) => (
              <span key={`cell-${i}`}>{cells[i] ?? ''}</span>
            ))}
          </span>
        );
      } else content = text(value, field.multiline === true);
      break;
    }
    case 'dropdown':
      content = text(typeof field.value === 'string' ? field.value : '');
      break;
    case 'button':
      content = text(field.label ?? '');
      break;
    case 'listbox': {
      const chosen = new Set(
        typeof field.value === 'string'
          ? [field.value]
          : typeof field.value === 'object'
            ? field.value
            : [],
      );
      content = (
        <span className={styles.lookList} style={{ fontSize: fontPx, padding }}>
          {(field.options ?? []).map((o) => (
            <span
              key={o}
              className={styles.lookOption}
              data-selected={chosen.has(o) || undefined}
              style={{ display: 'block', lineHeight: 1.2, textAlign: field.align }}
            >
              {o}
            </span>
          ))}
        </span>
      );
      break;
    }
    case 'checkbox':
      content =
        field.value === true ? (
          <svg className={styles.lookSvg} viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 5.2 L4.1 7.4 L8 2.8" fill="none" stroke="#000" strokeWidth="1.2" />
          </svg>
        ) : null;
      break;
    case 'radio': {
      const on = field.value !== undefined && field.widgets[widget]?.exportValue === field.value;
      content = on ? (
        <svg className={styles.lookSvg} viewBox="0 0 10 10" aria-hidden="true">
          <circle cx="5" cy="5" r="2.2" fill="#000" />
        </svg>
      ) : null;
      break;
    }
    case 'signature':
      content = (
        <svg
          className={styles.lookSvg}
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
          aria-hidden="true"
        >
          <line
            x1="8"
            x2="92"
            y1="72"
            y2="72"
            stroke={border ?? '#808080'}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      );
      break;
    default:
      content = null;
  }
  return (
    <div className={styles.look} style={style} data-created-look={field.name} aria-hidden="true">
      {content}
    </div>
  );
}

/**
 * The viewport's free rectangle in viewport coordinates: its box less its scroll padding,
 * which the full-bleed stage sets to the panels that cover it (craft spec §7).
 */
function freeRect(
  viewport: Element | null | undefined,
): { left: number; right: number; top: number; bottom: number } | undefined {
  if (!viewport) return undefined;
  const box = viewport.getBoundingClientRect();
  const style = getComputedStyle(viewport);
  const inset = (value: string) => {
    const px = Number.parseFloat(value);
    return Number.isFinite(px) ? px : 0;
  };
  return {
    left: box.left + inset(style.scrollPaddingLeft),
    right: box.right - inset(style.scrollPaddingRight),
    top: box.top + inset(style.scrollPaddingTop),
    bottom: box.bottom - inset(style.scrollPaddingBottom),
  };
}
