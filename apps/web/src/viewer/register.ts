/**
 * Registers the viewer's page overlays (stage/page-overlays.tsx) once, at module load:
 * text layer, then search highlights, then link hotspots (draw order).
 */
import { registerPageOverlay } from '../stage/page-overlays';
import { LinkLayer } from './LinkLayer';
import { SearchHighlights } from './SearchHighlights';
import { TextLayer } from './TextLayer';

// Explicit names: overlays are keyed by name, and minified function names can collide.
const overlays = [
  Object.assign(TextLayer, { displayName: 'ViewerTextLayer' }),
  Object.assign(SearchHighlights, { displayName: 'ViewerSearchHighlights' }),
  Object.assign(LinkLayer, { displayName: 'ViewerLinkLayer' }),
];

let registered = false;

export function registerViewerOverlays(): void {
  if (registered) return;
  registered = true;
  for (const overlay of overlays) registerPageOverlay(overlay);
}

registerViewerOverlays();
