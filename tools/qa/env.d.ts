/** Vite `?url` import of PDFium's wasm (resolved by Vitest's Vite server). */
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
