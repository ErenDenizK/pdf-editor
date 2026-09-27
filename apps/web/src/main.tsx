// Fonts are self-hosted from node_modules (CSP: font-src 'self', no data: URLs). Subsets
// load on demand through unicode-range, so unused scripts cost nothing. See fonts.css for
// why JetBrains Mono is declared by hand.
import '@fontsource-variable/inter/wght.css';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
