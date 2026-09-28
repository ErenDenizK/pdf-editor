/**
 * While "Draw crop area" is on (crop-store.ts): a floating hint over the stage that says
 * what to do and how to leave (Esc, or its Cancel button). Mounted once, next to the
 * operation dialogs.
 */
import { m } from '../i18n';
import { cancelCropDrawing } from './actions';
import styles from './Crop.module.css';
import { useCropStore } from './crop-store';

export function CropDrawBanner() {
  const drawing = useCropStore((s) => s.drawing !== null);
  if (!drawing) return null;
  return (
    <div className={styles.banner} role="status" data-testid="crop-draw-banner">
      <span>{m.crop_draw_hint()}</span>
      <button type="button" className={styles.bannerButton} onClick={cancelCropDrawing}>
        {m.common_cancel()}
      </button>
    </div>
  );
}
