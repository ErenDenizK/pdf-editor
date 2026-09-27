/** Vite `?url` imports (PDFium's wasm, pdf.js's worker and font data), resolved by Vite. */
declare module '*?url' {
  const url: string;
  export default url;
}

/** Vite CSS side-effect imports (pdf.js's viewer stylesheet for its annotation layer). */
declare module '*.css';

/** The @embedpdf/pdfium package version, injected by vitest.config.ts. */
declare const __PDFIUM_PACKAGE_VERSION__: string;

/** QA_MATRIX_EVIDENCE_DIR as an absolute path, or '' (injected by vitest.config.ts). */
declare const __MATRIX_EVIDENCE_DIR__: string;
