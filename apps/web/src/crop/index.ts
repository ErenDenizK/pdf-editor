/**
 * Crop pages (M4 §3, crop as CropBox with "crop and discard content"): the dialog, the
 * Read-mode drawing layer and its hint. Importing this module registers the drawing layer
 * (last, so it lies above every other page layer while drawing).
 */
import { registerPageOverlay } from '../stage/page-overlays';
import { CropLayer } from './CropLayer';

export { cropPages, planCrops, planDiscard } from './actions';
export { CropDialog } from './CropDialog';
export { CropDrawBanner } from './CropDrawBanner';

registerPageOverlay(Object.assign(CropLayer, { displayName: 'CropLayer' }));
