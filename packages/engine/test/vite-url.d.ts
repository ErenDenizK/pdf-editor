/**
 * Ambient declarations for Vite `?url` imports used by the tests. Library code never uses
 * this syntax: the app injects the wasm URL into the adapter as a plain string.
 */
declare module '*.wasm?url' {
  const url: string;
  export default url;
}

/** Test fixtures served by Vite. */
declare module '*.pdf?url' {
  const url: string;
  export default url;
}
