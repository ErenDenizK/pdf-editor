/**
 * The inline text editor (redaction-and-text-editing spec §2.2, §2.5): a one-line field
 * over the run's line box (turned with the line on rotated pages), pre-filled with the run
 * text, and a header with the font, the honesty badge and, when the new text is wider than
 * the free space, the fit choice. The badge follows `checkEditability` for the current
 * text (debounced); Enter commits one history entry through the edit runner, Esc cancels.
 * Either way the focus goes back to the run's target on the page (TextEditLayer), so the
 * keyboard continues where it was.
 */
import type { TextEditability } from '@pdf-editor/engine';
import { Ban, Check, CircleDashed, Info, type LucideIcon, TriangleAlert } from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { rectToCss } from '../annotations/geometry';
import { getEngineService } from '../engine/engine-service';
import { formatPercent, m } from '../i18n';
import { announce } from '../shell/announcer';
import { orientedPlacement, type PageFrame } from '../viewer/geometry';
import { commitTextEdit } from './actions';
import {
  type BadgeTone,
  editRange,
  failureMessage,
  type FitChoice,
  fitStateOf,
  fitSummary,
  fontLine,
  honestyBadge,
  resolveFit,
  screenAngle,
  singleLine,
} from './model';
import styles from './TextEdit.module.css';
import { type TextEditSession, useTextEditStore } from './text-edit-store';

/** Wait after the last keystroke before asking the engine again. */
const CHECK_DELAY_MS = 200;
/** Space kept around the line box inside the field, CSS pixels. */
const FIELD_PADDING = 3;
/** Gap between the line and the header, CSS pixels. */
const HEADER_GAP = 8;

type Check =
  | { readonly text: string; readonly result: TextEditability }
  | { readonly text: string; readonly error: string };

const TONE_ICONS: Record<BadgeTone | 'pending', LucideIcon> = {
  same: Check,
  info: Info,
  warning: TriangleAlert,
  blocked: Ban,
  pending: CircleDashed,
};

/** The query `checkEditability` gets for `text` (unchanged text: the whole line as is). */
function queryFor(session: TextEditSession, text: string) {
  const range = editRange(session.run, text) ?? {
    start: 0,
    end: session.run.text.length,
    replacement: session.run.text,
  };
  return { run: session.run, ...range };
}

export function TextEditor({
  session,
  frame,
  revision,
}: {
  readonly session: TextEditSession;
  readonly frame: PageFrame;
  readonly revision: number;
}) {
  const { run } = session;
  const [text, setText] = useState(run.text);
  const [check, setCheck] = useState<Check | null>(null);
  const [choice, setChoice] = useState<FitChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attention, setAttention] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<'above' | 'below'>('above');
  /** Leftward shift that keeps the header on the page. */
  const [shift, setShift] = useState(0);

  const close = useCallback(() => useTextEditStore.getState().close(), []);
  /** Closes from the keyboard: the focus returns to the run (`committed`: once re-located). */
  const finish = (committed: boolean) => useTextEditStore.getState().finish(committed);
  const refocus = () => requestAnimationFrame(() => inputRef.current?.focus());

  const runCheck = useCallback(
    async (value: string, signal?: AbortSignal): Promise<TextEditability | undefined> => {
      try {
        const editor = await getEngineService().textEditor();
        const result = await editor.checkEditability(
          queryFor(session, value),
          signal ? { signal } : {},
        );
        if (signal?.aborted) return undefined;
        setCheck({ text: value, result });
        return result;
      } catch (caught) {
        if (signal?.aborted) return undefined;
        const { textEditFailureReason } = await import('@pdf-editor/engine');
        setCheck({ text: value, error: failureMessage(textEditFailureReason(caught)) });
        return undefined;
      }
    },
    [session],
  );

  // Ask the engine about the current text, debounced; the first check runs at once.
  const first = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    const delay = first.current ? 0 : CHECK_DELAY_MS;
    first.current = false;
    const timer = window.setTimeout(() => void runCheck(text, controller.signal), delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [text, runCheck]);

  // The page changed under the editor (undo, another edit): the run is stale.
  useEffect(() => {
    if (!busy && revision !== session.revision) close();
  }, [busy, revision, session.revision, close]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(session.selection.start, session.selection.end);
  }, [session]);

  // The header goes above the line unless the scroll view (or the page) would clip it.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const input = inputRef.current;
    if (!panel || !input) return;
    const view = input.closest('[data-read-viewport]')?.getBoundingClientRect();
    const line = input.getBoundingClientRect();
    const room = line.top - (view?.top ?? 0);
    const next = room >= panel.offsetHeight + 2 * HEADER_GAP ? 'above' : 'below';
    if (next !== side) setSide(next);
    // Keep it on the page horizontally (lines near the right edge, rotated pages).
    const width = panel.parentElement?.clientWidth ?? 0;
    const overhang = Math.max(0, panel.offsetLeft + shift + panel.offsetWidth - width);
    const nextShift = Math.min(overhang, Math.max(0, panel.offsetLeft + shift));
    if (Math.abs(nextShift - shift) > 0.5) setShift(nextShift);
    // The header's size follows the check (fit block, error), the geometry the zoom.
  }, [side, shift, check, error, busy, frame]);

  const commit = async () => {
    if (busy) return;
    const value = text;
    const range = editRange(run, value);
    if (!range) {
      finish(false);
      return;
    }
    setError(null);
    setBusy(true);
    let current = check?.text === value && 'result' in check ? check.result : undefined;
    current ??= await runCheck(value);
    if (!current) {
      setBusy(false);
      refocus();
      return;
    }
    if (current.honesty === 'not-editable') {
      setBusy(false);
      setError(honestyBadge(current).detail ?? m.text_edit_error_not_editable());
      refocus();
      return;
    }
    const fitNow = fitStateOf(current);
    const fit = resolveFit(fitNow, choice);
    if (fit === null) {
      setBusy(false);
      setAttention(true);
      announce(fitNow ? fitSummary(fitNow) : m.text_edit_error_does_not_fit());
      refocus();
      return;
    }
    const outcome = await commitTextEdit({ target: session.target, run, ...range, fit });
    if (outcome.ok) {
      finish(true);
      return;
    }
    setBusy(false);
    setError(outcome.message);
    refocus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };

  // Geometry: the field covers the line box along the reading direction.
  const box = rectToCss(frame, run.lineBox);
  const angle = screenAngle(frame, run);
  const place = orientedPlacement(box, angle);
  const scaleOnPage = Math.hypot(run.matrix[0], run.matrix[1]) || 1;
  const fontPx = Math.max(6, Math.min(run.fontSize * scaleOnPage, 400) * frame.scale);
  const transforms = [
    ...(angle === 0 ? [] : [`rotate(${angle}deg)`]),
    `translate(${-FIELD_PADDING}px, ${-FIELD_PADDING}px)`,
  ];

  const result = check && 'result' in check ? check.result : undefined;
  const checkError = check && 'error' in check ? check.error : undefined;
  const pending = check?.text !== text;
  const badge = result ? honestyBadge(result) : undefined;
  const tone: BadgeTone | 'pending' = badge?.tone ?? 'pending';
  const Icon = TONE_ICONS[tone];
  const fitState = result ? fitStateOf(result) : undefined;
  const resolved = resolveFit(fitState, choice);

  const choose = (next: FitChoice) => {
    setChoice(next);
    setAttention(false);
    refocus();
  };

  return (
    <>
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        aria-label={m.text_edit_editor_label()}
        aria-describedby={panelId}
        data-text-edit-input=""
        value={text}
        readOnly={busy}
        spellCheck={false}
        autoComplete="off"
        style={{
          left: place.left,
          top: place.top,
          minWidth: place.length + 2 * FIELD_PADDING,
          height: place.thickness + 2 * FIELD_PADDING,
          fontSize: fontPx,
          transform: transforms.join(' '),
        }}
        onChange={(event) => {
          setText(singleLine(event.target.value));
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <div
        id={panelId}
        className={styles.panel}
        role="group"
        aria-label={m.text_edit_panel_label()}
        data-text-edit-panel=""
        ref={panelRef}
        data-side={side}
        style={{
          left: Math.max(0, box.left) - shift,
          top: side === 'above' ? box.top - HEADER_GAP : box.top + box.height + HEADER_GAP,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className={styles.font} data-testid="text-edit-font" title={run.font.baseName}>
          {fontLine(run.font)}
        </div>
        <div
          className={styles.badge}
          data-tone={tone}
          data-testid="text-edit-badge"
          role="status"
          aria-busy={pending || undefined}
        >
          <Icon aria-hidden="true" />
          <span>{badge?.label ?? (checkError ? '' : m.text_edit_badge_checking())}</span>
        </div>
        {badge?.detail ? <div className={styles.detail}>{badge.detail}</div> : null}
        {badge?.fellBack ? (
          <div className={styles.detail} data-testid="text-edit-fell-back">
            {badge.fellBack}
          </div>
        ) : null}
        {fitState && !fitState.fits ? (
          <div
            className={styles.fit}
            data-testid="text-edit-fit"
            data-attention={attention || undefined}
          >
            <p className={styles.fitText}>{fitSummary(fitState)}</p>
            <div className={styles.fitChoices}>
              <button
                type="button"
                className={styles.choice}
                aria-pressed={resolved === 'shrink'}
                disabled={!fitState.canShrink || busy}
                title={
                  fitState.canShrink
                    ? undefined
                    : m.text_edit_fit_shrink_floor({ percent: formatPercent(fitState.shrink) })
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose('shrink')}
              >
                {m.text_edit_fit_shrink({ percent: formatPercent(fitState.shrink) })}
              </button>
              <button
                type="button"
                className={styles.choice}
                aria-pressed={resolved === 'overflow'}
                disabled={busy}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose('overflow')}
              >
                {m.text_edit_fit_overflow()}
              </button>
            </div>
          </div>
        ) : null}
        {error || checkError ? (
          <p className={styles.error} role="alert" data-testid="text-edit-error">
            {error ?? checkError}
          </p>
        ) : null}
        <div className={styles.hint}>{busy ? m.text_edit_applying() : m.text_edit_hint()}</div>
      </div>
    </>
  );
}
