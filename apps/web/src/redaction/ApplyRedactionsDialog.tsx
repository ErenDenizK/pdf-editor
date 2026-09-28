/**
 * "Apply redactions" (spec redaction-and-text-editing §1.2): a confirmation that says
 * exactly what will happen (ticked marks become permanent removals, irreversible once
 * exported, attachments removed unless kept, fill and overlay text, "area only"), then the
 * apply with its self-check, then a result sheet with every report, or, when the gate or
 * the self-check stopped it, the stage and the findings with the document unchanged.
 */
import { Dialog } from '@base-ui/react/dialog';
import type { ForensicReport, RedactionGateReport } from '@pdf-editor/engine';
import { X } from 'lucide-react';
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';

import { useAnnotationStore } from '../annotations/annotation-store';
import exportStyles from '../export/ExportDialog.module.css';
import { formatNumber, m } from '../i18n';
import overlay from '../shell/ShortcutOverlay.module.css';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';
import { useRetained } from '../ui/use-retained';
import {
  type ApplyChoices,
  type ApplyOutcome,
  applyTickedRedactions,
  DEFAULT_CHOICES,
  type FillChoice,
  type SourceRedaction,
} from './apply';
import styles from './ApplyRedactions.module.css';
import { useApplyDialogStore } from './apply-store';
import { collectMarks, useRedactionStore } from './redaction-store';
import { checkName, failingCheckLines, leftoverName } from './report-text';

type Step =
  | { readonly kind: 'form' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done'; readonly outcome: ApplyOutcome };

export function ApplyRedactionsDialog() {
  const open = useApplyDialogStore((s) => s.open);
  const setOpen = useApplyDialogStore((s) => s.setOpen);
  // Keep the popup mounted while it animates closed (see useRetained).
  const [shown, release] = useRetained(open ? true : null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) release();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {shown ? <ApplyFlow onClose={() => setOpen(false)} /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function useTickCounts(): { readonly ticked: number; readonly unticked: number } {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const pages = useAnnotationStore((s) => s.pages);
  const excluded = useRedactionStore((s) => s.excluded);
  const keys = new Set(collectMarks(workspace, pages).entries.map((e) => e.markKey));
  const ticked = [...keys].filter((key) => !excluded.has(key)).length;
  return { ticked, unticked: keys.size - ticked };
}

const FILLS: readonly { readonly id: FillChoice; readonly swatch?: string }[] = [
  { id: 'black', swatch: '#000000' },
  { id: 'white', swatch: '#ffffff' },
  { id: 'custom' },
];

function fillLabel(id: FillChoice): string {
  if (id === 'black') return m.redaction_fill_black();
  if (id === 'white') return m.redaction_fill_white();
  return m.redaction_fill_custom();
}

function ApplyFlow({ onClose }: { readonly onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [choices, setChoices] = useState<ApplyChoices>(DEFAULT_CHOICES);
  const { ticked, unticked } = useTickCounts();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const set = (patch: Partial<ApplyChoices>) => setChoices((c) => ({ ...c, ...patch }));

  useEffect(() => {
    if (step.kind === 'done') primaryRef.current?.focus();
  }, [step.kind]);

  const apply = async (event: SyntheticEvent) => {
    event.preventDefault();
    setStep({ kind: 'working' });
    const outcome = await applyTickedRedactions(choices);
    setStep({ kind: 'done', outcome });
  };

  return (
    <Dialog.Popup
      className={`${overlay.popup} ${exportStyles.popup} ${styles.popup}`}
      data-testid="redaction-apply-dialog"
    >
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>
          {step.kind === 'done' && step.outcome.kind === 'applied'
            ? m.redaction_result_title()
            : step.kind === 'done' && step.outcome.kind === 'blocked'
              ? m.redaction_blocked_title()
              : m.redaction_apply_title()}
        </Dialog.Title>
        <Dialog.Close
          className={overlay.close}
          aria-label={m.common_close()}
          disabled={step.kind === 'working'}
        >
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>

      {step.kind === 'form' ? (
        <form className={exportStyles.body} onSubmit={(event) => void apply(event)}>
          <Dialog.Description className={exportStyles.description}>
            {m.redaction_apply_scope({ count: ticked, countText: formatNumber(ticked) })}{' '}
            {unticked > 0
              ? m.redaction_apply_unticked({ count: unticked, countText: formatNumber(unticked) })
              : null}
          </Dialog.Description>
          <p className={exportStyles.description}>{m.redaction_apply_what()}</p>
          <p className={styles.warning} role="note">
            {m.redaction_apply_irreversible()}
          </p>
          <fieldset className={exportStyles.section}>
            <legend className={exportStyles.sectionTitle}>{m.redaction_apply_fill()}</legend>
            <div className={styles.fills} role="radiogroup" aria-label={m.redaction_apply_fill()}>
              {FILLS.map((fill) => (
                <label key={fill.id} className={styles.fill}>
                  <input
                    type="radio"
                    name="redaction-fill"
                    checked={choices.fill === fill.id}
                    onChange={() => set({ fill: fill.id })}
                  />
                  {fill.swatch ? (
                    <span
                      className={styles.swatch}
                      style={{ background: fill.swatch }}
                      aria-hidden="true"
                    />
                  ) : null}
                  {fillLabel(fill.id)}
                </label>
              ))}
              {choices.fill === 'custom' ? (
                <input
                  type="color"
                  className={styles.color}
                  value={choices.customColor}
                  aria-label={m.redaction_fill_custom_label()}
                  onChange={(event) => set({ customColor: event.target.value })}
                />
              ) : null}
            </div>
            <label className={exportStyles.field}>
              <span className={exportStyles.label}>{m.redaction_overlay_label()}</span>
              <input
                className={exportStyles.input}
                value={choices.overlayText}
                placeholder={m.redaction_overlay_placeholder()}
                maxLength={60}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => set({ overlayText: event.target.value })}
              />
            </label>
          </fieldset>
          <fieldset className={exportStyles.section}>
            <label className={exportStyles.check}>
              <input
                type="checkbox"
                checked={choices.keepAttachments}
                onChange={(event) => set({ keepAttachments: event.target.checked })}
              />
              <span>
                {m.redaction_keep_attachments()}
                <span className={exportStyles.hint}>{m.redaction_keep_attachments_hint()}</span>
              </span>
            </label>
            <label className={exportStyles.check}>
              <input
                type="checkbox"
                checked={choices.areaOnly}
                onChange={(event) => set({ areaOnly: event.target.checked })}
              />
              <span>
                {m.redaction_area_only()}
                <span className={exportStyles.hint}>{m.redaction_area_only_hint()}</span>
              </span>
            </label>
          </fieldset>
          <div className={exportStyles.actions}>
            <Dialog.Close className={exportStyles.secondary}>{m.common_cancel()}</Dialog.Close>
            <button
              type="submit"
              className={exportStyles.primary}
              disabled={ticked === 0}
              data-testid="redaction-apply-confirm"
            >
              {m.redaction_apply_confirm()}
            </button>
          </div>
        </form>
      ) : null}

      {step.kind === 'working' ? (
        <div className={exportStyles.body}>
          <p className={exportStyles.description} role="status">
            {m.redaction_applying()}
          </p>
          <progress className={exportStyles.progress} aria-label={m.redaction_applying()} />
        </div>
      ) : null}

      {step.kind === 'done' ? (
        <div className={exportStyles.body}>
          <Outcome outcome={step.outcome} />
          <div className={exportStyles.actions}>
            {step.outcome.kind === 'applied' ? null : (
              <button
                type="button"
                className={exportStyles.secondary}
                onClick={() => setStep({ kind: 'form' })}
              >
                {m.common_back()}
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              className={exportStyles.primary}
              onClick={onClose}
            >
              {m.common_close()}
            </button>
          </div>
        </div>
      ) : null}
    </Dialog.Popup>
  );
}

function Outcome({ outcome }: { readonly outcome: ApplyOutcome }) {
  if (outcome.kind === 'applied') {
    return (
      <div className={styles.stack} data-testid="redaction-result">
        {outcome.sources.map((source) => (
          <SourceResult key={source.source} source={source} showName={outcome.sources.length > 1} />
        ))}
        <p className={styles.note}>{m.redaction_result_export_note()}</p>
      </div>
    );
  }
  if (outcome.kind === 'blocked') {
    const { failure } = outcome;
    const failing = failure.forensic?.checks.filter((c) => !c.passed).map((c) => c.id) ?? [];
    const lines =
      outcome.stage === 'gate' && failure.gate
        ? gateLines(failure.gate)
        : failure.forensic
          ? failingCheckLines(failure.forensic)
          : [];
    return (
      <div className={styles.stack} data-testid="redaction-blocked">
        <p className={exportStyles.error} role="alert" data-stage={outcome.stage}>
          {outcome.stage === 'gate' ? m.redaction_blocked_gate() : m.redaction_blocked_forensic()}
        </p>
        {outcome.name ? (
          <p className={styles.note}>{m.redaction_blocked_source({ name: outcome.name })}</p>
        ) : null}
        {lines.length > 0 ? (
          <ul className={styles.findings} data-testid="redaction-findings">
            {lines.map((line, index) => (
              <li key={`${index}:${line}`}>{line}</li>
            ))}
          </ul>
        ) : null}
        {failing.includes('no-search-hits') ? (
          <p className={styles.note}>{m.redaction_blocked_hint_search()}</p>
        ) : null}
        {failure.plan.keepAttachments &&
        (failure.forensic?.unverifiedAttachments.length ?? 0) > 0 &&
        (failing.includes('object-strings') || failing.includes('byte-grep')) ? (
          <p className={styles.note}>{m.redaction_blocked_hint_attachments()}</p>
        ) : null}
        {failure.forensic ? <CheckList report={failure.forensic} /> : null}
      </div>
    );
  }
  if (outcome.kind === 'error') {
    return (
      <p className={exportStyles.error} role="alert">
        {m.redaction_apply_failed()} {outcome.message}
      </p>
    );
  }
  return <p className={exportStyles.description}>{m.redaction_apply_none()}</p>;
}

function gateLines(gate: RedactionGateReport): string[] {
  return gate.areas
    .filter((area) => !area.blank)
    .map((area) =>
      m.redaction_blocked_area({
        page: area.pageIndex + 1,
        area: area.areaIndex + 1,
        kinds: area.remaining.map(leftoverName).join(', '),
      }),
    );
}

function SourceResult({
  source,
  showName,
}: {
  readonly source: SourceRedaction;
  readonly showName: boolean;
}) {
  const { result } = source;
  const pages = new Set(result.plan.areas.map((a) => a.pageIndex)).size;
  const areas = m.redaction_result_areas({
    count: result.plan.areas.length,
    countText: formatNumber(result.plan.areas.length),
    pages: pagesPhrase(pages),
  });
  const report = result.redaction;
  const facts: [string, number][] = [
    [m.redaction_result_paths(), result.engine.pathsRemoved],
    [m.redaction_result_images(), result.engine.imagesRemoved],
    [m.redaction_result_annotations(), report.annotationsRemoved],
    [m.redaction_result_fields(), report.fieldsCleared],
    [m.redaction_result_strings(), report.stringsReplaced],
    [m.redaction_result_searched(), result.plan.strings.length],
    [m.redaction_result_attachments(), report.attachments.removed],
    [m.redaction_result_kept_marks(), source.keptMarks],
  ];
  return (
    <section className={styles.stack} data-redaction-source="">
      <h3 className={styles.sourceTitle} data-testid="redaction-result-areas">
        {showName ? m.redaction_result_source({ name: source.name, areas }) : areas}
      </h3>
      <dl className={styles.facts}>
        {facts.map(([label, value]) => (
          <div key={label} className={styles.fact}>
            <dt>{label}</dt>
            <dd>{formatNumber(value)}</dd>
          </div>
        ))}
      </dl>
      {report.attachments.unverified.length > 0 ? (
        <p className={styles.note}>
          {m.redaction_result_unverified({ names: report.attachments.unverified.join(', ') })}
        </p>
      ) : null}
      {report.structure === 'pruned' ? (
        <p className={styles.note}>{m.redaction_result_tags_pruned()}</p>
      ) : report.structure === 'untagged' ? (
        <p className={styles.note}>{m.redaction_result_tags_removed()}</p>
      ) : null}
      {result.gate.ok ? <p className={exportStyles.verified}>{m.redaction_result_gate()}</p> : null}
      <CheckList report={result.forensic} />
    </section>
  );
}

function CheckList({ report }: { readonly report: ForensicReport }) {
  const passed = report.checks.filter((c) => c.passed).length;
  return (
    <>
      <p className={styles.note} data-testid="redaction-checks-summary">
        {m.redaction_result_checks({
          passed: formatNumber(passed),
          total: formatNumber(report.checks.length),
        })}
      </p>
      <ul
        className={styles.checks}
        aria-label={m.redaction_result_checks({ passed, total: report.checks.length })}
      >
        {report.checks.map((check) => (
          <li
            key={check.id}
            data-check={check.id}
            data-passed={String(check.passed)}
            data-testid="redaction-check"
          >
            <span>{checkName(check.id)}</span>
            <span className={styles.status}>
              {check.passed ? m.redaction_check_passed() : m.redaction_check_failed()}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
