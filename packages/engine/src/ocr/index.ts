/**
 * OCR to searchable PDF (spec recognize-and-compare §1, ADR-0012). In the app:
 * `PdfOcrLayer` (`ocrPageFacts`, `renderForOcr`, `applyOcrLayer`) runs in the PDFium worker
 * behind `PdfiumProxy`; the recognizer (`createOcrRecognizer`) runs on the main thread and
 * posts pages to tesseract.js's own worker; `ocr.apply` edits record the words (edit.ts).
 */
export {
  applyOcrLayerToBytes,
  type ApplyOcrLayerOptions,
  type OcrHost,
  OcrLayerFailedError,
} from './apply';
export {
  applyOcrEdit,
  type OcrApplyPayload,
  ocrApplyEdit,
  ocrApplyPayloadOf,
  ocrLayerPlanOf,
  type OcrReplayPayload,
  type OcrStoredPage,
  type OcrStoredWord,
  readOcrApplyPayload,
} from './edit';
export { languageTag, pixelBoxToUser, wordsFromBlocks } from './geometry';
export { GLYPHLESS_FONT_SHA256, glyphlessFontBytes } from './glyphless-font';
export { layerContent, type OcrLayerWriteResult, writableWord, writeOcrLayer } from './layer';
export {
  codeFromFileName,
  gunzip,
  isGzip,
  looksLikeTraineddata,
  OCR_CACHE_NAME,
  OCR_LOCK,
  type OcrLanguagePack,
  type OcrPackLoadOptions,
  OcrPackStore,
  type OcrPackStoreOptions,
  sha256Hex,
} from './packs';
export { encodePgm, readPgmHeader } from './pgm';
export { meanConfidence, ocrDpiFor, ocrQuality, ocrReportOf } from './quality';
export { OCR_MARK } from './raw';
export {
  createOcrRecognizer,
  OCR_IDLE_MS,
  OCR_PAGE_TIMEOUT_MS,
  type OcrCoreVariant,
  ocrCoreVariant,
  ocrEngineFiles,
  type TesseractRecognizerOptions,
} from './recognizer';
export {
  edgeDeviation,
  layerWordRect,
  locateWords,
  OCR_RECT_TOLERANCE,
  verifyOcrLayer,
} from './verify';
