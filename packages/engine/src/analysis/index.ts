/** Comparison (M5 spec §2): the analysis worker's computation, usable on any thread. */
export {
  type AlignRequest,
  AnalysisCore,
  type AnalysisBackend,
  type CompareJobHeader,
  createLocalAnalysisBackend,
  type FinishRequest,
  type Side as CompareSide,
  type VisualRequest,
} from './backend';
export { COMPARE_NOTES, ComparisonSession } from './comparison';
export { diffFacts, extractCompareFacts, factsFromEngine, parseXmp } from './facts';
export {
  compareDocuments,
  type CompareRun,
  type CompareSource,
  pdfiumCompareSource,
  type PdfiumCompareSourceOptions,
} from './pipeline';
export { type SliceStats } from './scheduler';
export { normalizeToken, type PageToken, type PageTokens, tokenizePage } from './tokens';
