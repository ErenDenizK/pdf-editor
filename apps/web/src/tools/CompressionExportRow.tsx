/**
 * One summary row of the export dialog (spec §8): before the export, the compression
 * preset applied to this document ("Apply to export" in the compress dialog); after it,
 * the measured size change. Renders nothing when no preset is applied. Main-chunk safe:
 * reads the tools store and messages only.
 */
import type { DocumentId } from '@pdf-editor/document-model';

import { formatBytes } from '../files/file-filters';
import { m } from '../i18n';
import { deltaPercent } from './compress-math';
import { presetDescription, presetName } from './labels';
import { useToolsStore } from './tools-store';

export function CompressionExportRow({
  documentId,
  className,
  result,
}: {
  /** The document whose applied preset is shown (form step). */
  readonly documentId?: DocumentId;
  readonly className?: string | undefined;
  /** The export's measured sizes (review step); absent before exporting. */
  readonly result?: {
    readonly preset: Parameters<typeof presetName>[0];
    readonly before: number;
    readonly after: number;
  };
}) {
  const settings = useToolsStore((s) =>
    documentId === undefined ? undefined : s.exportCompression[documentId],
  );
  if (result) {
    return (
      <p className={className} data-testid="export-compression">
        {m.export_compression_delta({
          preset: presetName(result.preset),
          before: formatBytes(result.before),
          after: formatBytes(result.after),
          delta: deltaPercent(result.before, result.after),
        })}
      </p>
    );
  }
  if (!settings) return null;
  return (
    <p className={className} data-testid="export-compression">
      {m.export_compression_row({ preset: presetDescription(settings) })}
    </p>
  );
}
