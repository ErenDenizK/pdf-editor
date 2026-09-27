import { fileURLToPath } from 'node:url';

import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// GitHub Pages serves project sites under `/<repo>/`; CI sets VITE_BASE_PATH accordingly
// (ADR-0004). Every path-dependent setting must derive from `base`.
const base = process.env.VITE_BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    // React Compiler (ADR-0003), applied through Babel. Rolldown's filter in the preset
    // limits Babel to files that can contain components or hooks.
    babel({ presets: [reactCompilerPreset()] }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // Static "not found" page for GitHub Pages. Built as an HTML entry (not copied from
        // `public/`) so that `%BASE_URL%` is substituted; no SPA redirect trick (ADR-0004).
        notFound: fileURLToPath(new URL('./404.html', import.meta.url)),
      },
    },
  },
});
