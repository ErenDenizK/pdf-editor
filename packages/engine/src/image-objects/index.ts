/**
 * Image objects on the PDFium host (M4 §3, ADR-0011): `PdfImageEditor` (locate, extract,
 * move / resize, remove, replace, each verified by locating the page's images again).
 */
export {
  createImageEditor,
  HostedImageEditor,
  IMAGE_TRANSFORM_TOLERANCE,
  type ImageEditorHost,
} from './editor';
export { type ImageEditFailure, imageEditError, imageEditFailureReason } from './errors';
export { finalizeContentEdits, type FinalizeContentEditsResult } from './finalize';
export {
  applyMatrix,
  effectiveDpi,
  imageBounds,
  invertMatrix,
  matrixForRect,
  multiplyMatrix,
} from './geometry';
