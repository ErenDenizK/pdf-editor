/** PDF → text / Markdown (M5 spec §4): layout and rendering, usable on any thread. */
export { CONVERT_NOTES, ConvertSession, convertPages } from './convert';
export { convertDocument, type ConvertSource, pdfiumConvertSource } from './pipeline';
export { encodePng } from './png';
