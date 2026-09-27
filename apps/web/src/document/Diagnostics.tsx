/**
 * Diagnostics in the Info section's collapsible "Details" (spec document-tools.md §7):
 * version, pages, encryption, linearization, tagging, form type, fonts, images (pixel sizes
 * and an approximate resolution), annotations, attachments, JavaScript and structural
 * warnings. Computed in the assembly worker only once the disclosure opens.
 */
import type { SourceDocument } from '@pdf-editor/document-model';
import type { SourceDiagnostics } from '@pdf-editor/engine';
import { useState } from 'react';

import { formatNumber, m } from '../i18n';
import { type DiagnosticsEntry, useSourceDiagnostics } from './diagnostics';
import styles from './DocumentTools.module.css';
import { handlerLabel } from './security-text';

export function DiagnosticsDetails({ sources }: { readonly sources: readonly SourceDocument[] }) {
  const [open, setOpen] = useState(false);
  const entries = useSourceDiagnostics(
    sources.map((s) => s.id),
    open,
  );
  return (
    <details
      className={styles.details}
      data-testid="diagnostics"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.detailsSummary}>{m.diag_title()}</summary>
      {open
        ? sources.map((source, index) => (
            <section key={source.id} className={styles.diagSource} aria-label={source.name}>
              {sources.length > 1 ? <h3 className={styles.subheading}>{source.name}</h3> : null}
              <DiagnosticsEntryView entry={entries[index]} />
            </section>
          ))
        : null}
    </details>
  );
}

function DiagnosticsEntryView({ entry }: { readonly entry: DiagnosticsEntry | undefined }) {
  if (entry === undefined || entry.status === 'loading') {
    return (
      <p className={styles.note} role="status">
        {m.diag_loading()}
      </p>
    );
  }
  if (entry.status === 'failed') {
    return <p className={styles.error}>{m.diag_failed({ reason: entry.message })}</p>;
  }
  return <DiagnosticsView diagnostics={entry.value} />;
}

const yesNo = (value: boolean) => (value ? m.common_yes() : m.common_no());

function fontsLine(d: SourceDiagnostics): string {
  const { total, embedded, notEmbedded, subset } = d.fonts;
  if (total === 0) return m.diag_none();
  return m.diag_fonts({
    total: formatNumber(total),
    embedded: formatNumber(embedded),
    subset: formatNumber(subset),
    missing: formatNumber(notEmbedded),
  });
}

function imagesLine(d: SourceDiagnostics): string {
  const { count, minDpi, medianDpi } = d.images;
  if (count === 0) return m.diag_none();
  if (minDpi === undefined || medianDpi === undefined) {
    return m.diag_images_count({ count: formatNumber(count) });
  }
  return m.diag_images({
    count: formatNumber(count),
    min: formatNumber(minDpi),
    median: formatNumber(medianDpi),
  });
}

function annotationsLine(d: SourceDiagnostics): string {
  if (d.annotations.total === 0) return m.diag_none();
  const parts = Object.entries(d.annotations.bySubtype)
    .sort((a, b) => b[1] - a[1])
    .map(([subtype, count]) => `${formatNumber(count)} ${subtype}`);
  return `${formatNumber(d.annotations.total)} (${parts.join(', ')})`;
}

function formLine(d: SourceDiagnostics): string {
  if (d.formType === 'xfa') return m.diag_form_xfa();
  if (d.formType === 'acroform') return m.diag_form_acroform({ count: formatNumber(d.formFields) });
  return m.diag_none();
}

/** The facts of one source (also rendered directly by tests from a fixture). */
export function DiagnosticsView({ diagnostics: d }: { readonly diagnostics: SourceDiagnostics }) {
  const version =
    d.extensionLevel === undefined
      ? d.version
      : m.diag_version_extension({ version: d.version, level: String(d.extensionLevel) });
  return (
    <div className={styles.diag}>
      {d.partial ? <p className={styles.note}>{m.diag_partial()}</p> : null}
      <dl className={styles.facts} data-testid="diagnostics-facts">
        <dt>{m.diag_version()}</dt>
        <dd>{version}</dd>
        <dt>{m.diag_pages()}</dt>
        <dd className={styles.numeric}>{formatNumber(d.pageCount)}</dd>
        <dt>{m.diag_encryption()}</dt>
        <dd>
          {d.encryption
            ? m.diag_encryption_value({
                handler: handlerLabel(d.encryption.handler),
                revision: String(d.encryption.r),
              })
            : m.diag_none()}
        </dd>
        <dt>{m.diag_linearized()}</dt>
        <dd>{yesNo(d.linearized)}</dd>
        <dt>{m.diag_tagged()}</dt>
        <dd>{yesNo(d.tagged)}</dd>
        <dt>{m.diag_form()}</dt>
        <dd>{formLine(d)}</dd>
        <dt>{m.diag_fonts_label()}</dt>
        <dd className={styles.wrap}>{fontsLine(d)}</dd>
        <dt>{m.diag_images_label()}</dt>
        <dd className={styles.wrap}>{imagesLine(d)}</dd>
        <dt>{m.diag_annotations()}</dt>
        <dd className={styles.wrap}>{annotationsLine(d)}</dd>
        <dt>{m.diag_attachments()}</dt>
        <dd className={styles.wrap}>
          {d.metadata.attachments === 0
            ? m.diag_none()
            : `${formatNumber(d.metadata.attachments)}${
                d.metadata.attachmentNames.length > 0
                  ? ` (${d.metadata.attachmentNames.join(', ')})`
                  : ''
              }`}
        </dd>
        <dt>{m.diag_javascript()}</dt>
        <dd>{yesNo(d.metadata.javascript > 0)}</dd>
        <dt>{m.diag_xmp()}</dt>
        <dd>{yesNo(d.metadata.xmpPackets > 0)}</dd>
      </dl>
      {d.fonts.list.length > 0 ? (
        <details className={styles.subDetails}>
          <summary>{m.diag_font_list({ count: formatNumber(d.fonts.list.length) })}</summary>
          <ul className={styles.list}>
            {d.fonts.list.map((font, index) => (
              <li key={`${font.name}-${index}`}>
                {font.name} · {font.subtype} ·{' '}
                {font.embedded
                  ? font.subset
                    ? m.diag_font_subset()
                    : m.diag_font_embedded()
                  : m.diag_font_not_embedded()}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {d.images.list.length > 0 ? (
        <details className={styles.subDetails}>
          <summary>{m.diag_image_list({ count: formatNumber(d.images.list.length) })}</summary>
          <ul className={styles.list}>
            {d.images.list.map((image, index) => (
              <li key={index}>
                {formatNumber(image.width)} × {formatNumber(image.height)} px
                {image.filter ? ` · ${image.filter}` : ''}
                {image.colorSpace ? ` · ${image.colorSpace}` : ''}
                {image.dpi === undefined
                  ? ''
                  : ` · ${m.diag_dpi_approx({ dpi: formatNumber(image.dpi) })}`}
                {image.pageIndex === undefined
                  ? ''
                  : ` · ${m.diag_on_page({ page: formatNumber(image.pageIndex + 1) })}`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {d.warnings.length > 0 ? (
        <ul className={styles.warnings} aria-label={m.diag_warnings()}>
          {d.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
