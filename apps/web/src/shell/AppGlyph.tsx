/**
 * Placeholder brand glyph (DESIGN.md §6): one path, no gradient, legible at 16px.
 * A page with a folded corner, drawn as one path of two subpaths. Kept in sync with
 * `public/icons/glyph.svg` and `public/icons/app-icon.svg`.
 */
export const GLYPH_PATH =
  'M6 2.5h7v5.5a2 2 0 0 0 2 2h5.5v9.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2ZM14.75 2.5 20.5 8.25h-4.75a1 1 0 0 1-1-1Z';

export function AppGlyph({ size = 16 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={GLYPH_PATH} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
