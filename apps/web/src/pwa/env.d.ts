/// <reference types="vite-plugin-pwa/vanillajs" />

// Build identity, replaced at build time by `define` in vite.config.ts (ADR-0017 §6).
// Read them through src/shell/about/build-info.ts rather than directly.
/** The web package version, e.g. "1.0.0-beta.0". */
declare const __APP_VERSION__: string;
/** Short SHA of the built commit, or "unknown". */
declare const __APP_COMMIT__: string;
/** ISO 8601 build time (pinned by SOURCE_DATE_EPOCH when set). */
declare const __BUILD_DATE__: string;
