/**
 * Live preview of page furniture (document-tools spec §2) in Read mode: every overlay of
 * the page — or, while a furniture dialog is open, its preview — drawn as SVG with the
 * bundled fonts, placed by the same layout function as the export. Registered through
 * stage/page-overlays.tsx.
 *
 * Approximations (the export is exact): "behind" overlays use multiply blending instead of
 * being drawn under the page content; images are drawn at the blob's pixel size × scale.
 * Clicks are handled by furniture/index.ts (window capture), so the layer never blocks
 * text selection; it publishes its laid-out boxes for that hit test.
 */
import {
  type DocumentId,
  effectiveLabel,
  findPageLocation,
  type PageId,
} from '@pdf-editor/document-model';
import {
  type LaidOutOverlay,
  pageOverlays,
  resolveFont,
  SYNTHETIC_BOLD_STROKE,
} from '@pdf-editor/engine/overlay-geometry';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { PageOverlayProps } from '../stage/page-overlays';
import { useWorkspaceStore } from '../state/workspace-store';
import { cssFontFamily, fontsVersion, measureOverlayText, subscribeFonts } from './furniture-fonts';
import { FURNITURE_ROLES, rgbToHex } from './furniture-model';
import { batesFor, boxTransform, layoutPage, overlaysForPage } from './furniture-preview';
import { useFurnitureStore } from './furniture-store';
import styles from './FurnitureLayer.module.css';
import { blobInfo, blobUrl } from './preview-blobs';

export interface PageHitInfo {
  readonly documentId: DocumentId;
  readonly laid: readonly LaidOutOverlay[];
  /** Displayed page height in points (for the y flip). */
  readonly heightPt: number;
  readonly cssScale: number;
}

/** Laid-out furniture per rendered page, for the click hit test. */
export const pageHits = new Map<PageId, PageHitInfo>();

/** Today, fixed per minute so the preview does not re-render every second. */
function today(): Date {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000);
}

export function FurnitureLayer(props: PageOverlayProps) {
  const { page, pageId, pageIndex, sizePt, visible } = props;
  const workspace = useWorkspaceStore((s) => s.workspace);
  const blobs = useWorkspaceStore((s) => s.blobs);
  const preview = useFurnitureStore((s) => s.preview);
  const dialog = useFurnitureStore((s) => s.dialog);
  const version = useSyncExternalStore(subscribeFonts, fontsVersion, fontsVersion);
  const location = findPageLocation(workspace, pageId);
  const doc = location ? workspace.documents[location.document] : undefined;
  // Document-level furniture (inherited by every page) first, then the page's own.
  const overlays = overlaysForPage(pageOverlays(doc?.furniture, page.overlays), doc?.id, preview);

  const laid = useMemo(() => {
    // `version` (fonts loaded) and `blobs` are dependencies: re-measure when they change.
    if (!doc || overlays.length === 0 || !visible || version < 0 || !blobs) return [];
    const bates = batesFor(workspace, doc.id, preview);
    return layoutPage(
      overlays,
      {
        index: pageIndex,
        count: doc.pages.length,
        page: sizePt,
        label: effectiveLabel(workspace, doc, pageIndex),
        title: doc.metadata.title ?? doc.title,
        date: today(),
        ...(doc.metadata.language ? { locale: doc.metadata.language } : {}),
        ...(bates ? { bates } : {}),
      },
      {
        textWidth: measureOverlayText,
        imageSize: (overlay) => {
          const blob = blobInfo(overlay.blob);
          return blob ? { width: blob.width, height: blob.height } : undefined;
        },
      },
    );
  }, [doc, overlays, visible, version, blobs, pageIndex, sizePt, workspace, preview]);

  useEffect(() => {
    if (!doc || laid.length === 0) {
      pageHits.delete(pageId);
      return;
    }
    pageHits.set(pageId, {
      documentId: doc.id,
      laid,
      heightPt: sizePt.height,
      cssScale: props.cssScale,
    });
    return () => {
      pageHits.delete(pageId);
    };
  }, [doc, laid, pageId, sizePt.height, props.cssScale]);

  if (laid.length === 0) return null;
  const selectedRoles = dialog && dialog.documentId === doc?.id ? FURNITURE_ROLES[dialog.kind] : [];
  const H = sizePt.height;

  return (
    <div className={styles.layer} data-furniture-layer="" aria-hidden="true">
      <svg
        className={styles.svg}
        viewBox={`0 0 ${sizePt.width} ${H}`}
        preserveAspectRatio="none"
        focusable="false"
      >
        {laid.map((item, i) => {
          const layerClass = item.overlay.layer === 'behind' ? styles.behind : undefined;
          const selected =
            item.overlay.role !== undefined && selectedRoles.includes(item.overlay.role);
          if (item.kind === 'image') {
            const href = blobUrl(item.overlay.blob);
            if (!href) return null;
            return (
              <g
                key={i}
                className={layerClass}
                opacity={item.overlay.opacity}
                data-role={item.overlay.role}
              >
                {item.boxes.map((box, j) => (
                  <image
                    key={j}
                    href={href}
                    width={box.width}
                    height={box.height}
                    preserveAspectRatio="none"
                    transform={`${boxTransform(box, H)} translate(0 ${-box.height})`}
                  />
                ))}
                {selected ? <Outline box={item.boxes[0]} H={H} /> : null}
              </g>
            );
          }
          const { overlay } = item;
          const resolved = resolveFont(overlay.font);
          const bundled = resolved.kind === 'bundled';
          const weight = bundled ? resolved.face.weight : resolved.bold ? 700 : 400;
          const italic = bundled ? resolved.syntheticItalic : false;
          const syntheticBold = bundled && resolved.syntheticBold;
          const fill = rgbToHex(overlay.color);
          return (
            <g
              key={i}
              className={layerClass}
              data-role={overlay.role}
              data-furniture-text={item.text}
            >
              {item.boxes.map((box, j) => (
                <text
                  key={j}
                  className={styles.text}
                  transform={boxTransform(box, H, italic)}
                  fontFamily={cssFontFamily(resolved)}
                  fontSize={overlay.font.size}
                  fontWeight={weight}
                  fontStyle={!bundled && resolved.italic ? 'italic' : 'normal'}
                  fill={fill}
                  opacity={overlay.opacity}
                  {...(syntheticBold
                    ? {
                        stroke: fill,
                        strokeWidth: overlay.font.size * SYNTHETIC_BOLD_STROKE,
                        strokeLinejoin: 'round' as const,
                      }
                    : {})}
                >
                  {item.text}
                </text>
              ))}
              {selected ? <Outline box={item.boxes[0]} H={H} /> : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Outline({
  box,
  H,
}: {
  readonly box: LaidOutOverlay['boxes'][number] | undefined;
  readonly H: number;
}) {
  if (!box) return null;
  const pad = 3;
  return (
    <rect
      className={styles.selected}
      x={-pad}
      y={-box.height - pad}
      width={box.width + 2 * pad}
      height={box.height + 2 * pad}
      transform={boxTransform(box, H)}
    />
  );
}
