# Design

**Status:** draft for discussion (2026-09-26). This document defines intent and system;
visual explorations will be added under `docs/design/` as they are produced.

## 1. Intent

Quiet, dense, professional. The document is the only bright thing on screen; the
application recedes into a near-black field. Nothing glows. Hierarchy comes from tonal
steps and hairline borders, not from shadows or saturated color; only floating chrome
floats, with one elevation token (§3). The product should feel
closer to Linear, Raycast and Apple Preview than to Acrobat or any "PDF tools" site.

References studied in `research/02-market-and-ux.md` §5: Linear (surface ladder, single
accent), Raycast (no shadows, hairline borders, keycap shortcut hints), Vercel Geist
(neutrals only, accent as punctuation), Apple Preview (thumbnail sidebar you drag pages
into), tldraw (canvas app layout, selection-driven style panel), Excalidraw (island
containers; and the anti-pattern of CSS-invert dark mode).

*Amended 2026-10-01 (M6, A1): floating chrome carries one elevation token.*

## 2. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ●  report.pdf ×  invoice.pdf ×  + │            ⌘K Search commands…  │ ◐ │  ← title/tab bar
├──────┬───────────────────────────────────────────────────────┬───────────┤
│      │                                                       │           │
│ Pages│                                                       │ Selection │
│ Outl.│         document canvas  /  light table               │ Properties│
│ Files│                                                       │ History   │
│      │                                                       │ Info      │
│      │                                                       │           │
│      │              ┌───────────────────────────┐            │           │
│      │              │ ▭ ✎ T ✦ ▣  │ ↺ ⌫ ⇱     │            │  ← floating tool bar
│      │              └───────────────────────────┘            │    (glass, over document)
├──────┴───────────────────────────────────────────────────────┴───────────┤
│ 12 pages · 2 selected · Local only, 0 external requests      100%  ⊟ ⊞  │  ← status bar
└──────────────────────────────────────────────────────────────────────────┘
```

- **Two modes of the center pane**, one mental model: *Read* (continuous pages) and
  *Arrange* (light table grid). Switching is one key. Selection carries across.
- **Left rail** collapses to icons; panels remember their state.
- **Right panel** shows only what applies to the current selection (page, annotation,
  document). Empty selection shows document info and history.
- **Floating tool bar** at bottom center over the document. It shows the tools of the
  current mode; a second, contextual bar appears above a selection (highlight/underline/
  comment for text; rotate/delete/extract for pages; color/stroke/opacity for an
  annotation).
- **Floating chrome is frosted glass; everything docked is opaque.** Glass: the floating
  tool bar, the contextual bars (annotation, image, Arrange), the crop banner, the command
  palette, every menu, the privacy and link popovers, and the popovers anchored to the page
  (text-edit header, note popup, form notice). Opaque: the tab bar, left rail, right panel and status bar,
  dialogs (and their scrim), tooltips, the created-field properties popover and the update
  toast. Details and fallbacks are in §3.
- **Command palette** (Cmd/Ctrl+K) lists every action with its shortcut, accepts
  arguments ("rotate 3-5 90", "go 42"), shows recents.
- **Status bar** carries the privacy indicator, zoom, and selection summary.
- Hover states never shift layout; space is reserved.

## 3. Tokens

Dark is the default and the primary theme. A light theme follows the same ladder inverted
and is a v1.x item, not a v1 blocker. The source of truth is
`apps/web/src/styles/tokens.css`; this is its shape after the refinement pass (§7).

```css
:root {
  /* surface ladder: canvas → panel → raised → overlay; hover and active are white washes */
  --surface-0: #0a0b0d;   /* app canvas */
  --surface-1: #101215;   /* panels */
  --surface-2: #16181c;   /* raised: cards, inputs */
  --surface-3: #1c1f24;   /* view-switch "on", disabled primary buttons */
  --surface-hover:  rgb(255 255 255 / 0.045);
  --surface-active: rgb(255 255 255 / 0.075);
  --scrim: rgb(5 6 8 / 0.56);

  /* glass: floating chrome over the document (the global .glass rule) */
  --glass: rgb(24 26 31 / 0.5);
  --glass-filter: blur(24px) saturate(1.8) brightness(0.4);
  --glass-solid: #16181c;               /* opaque fallback */
  --glass-text-secondary: #b4b8bf;      /* secondary and tertiary text on glass */
  --glass-text-disabled: #6f737b;
  --glass-danger: #ff8a8a;
  /* the one elevation, floating chrome only: inner top highlight, hairline ring, one soft shadow */
  --elevation-float: inset 0 1px 0 rgb(255 255 255 / 0.08), 0 0 0 1px rgb(0 0 0 / 0.5),
                     0 8px 24px -8px rgb(0 0 0 / 0.55);

  /* borders: one alpha, one control step, one swatch ring */
  --border-hairline: rgb(255 255 255 / 0.10);  /* dividers, surfaces, keycaps, page hairline */
  --border-glass:    rgb(255 255 255 / 0.10);
  --border-strong:   rgb(255 255 255 / 0.16);  /* inputs and control outlines (WCAG 1.4.11) */
  --border-swatch:   rgb(255 255 255 / 0.28);  /* separates arbitrary colours from the bar */

  --text-primary:   #e6e7ea;
  --text-secondary: #9a9ea6;
  --text-tertiary:  #858a92;  /* the draft's #6b7078 was 3.8:1; this is ≥ 4.76:1 on surface-0..3 */
  --text-disabled:  #4a4e55;

  /* one accent: focus, selection, primary action */
  --accent:          #7c8cff;
  --accent-hover:    #8f9dff;  /* primary button hover */
  --accent-pressed:  #6f7ff5;  /* primary button pressed */
  --tool-active-fill: var(--accent);     /* the armed tool: a solid fill … */
  --tool-active-ink:  var(--surface-0);  /* … with a canvas-dark icon */
  --accent-subtle:   rgb(124 140 255 / 0.08);  /* washes, hover fills, previews */
  --accent-muted:    rgb(124 140 255 / 0.16);  /* selected and current fills */
  --accent-line:     rgb(124 140 255 / 0.45);  /* 1px rings on non-focus states */
  --accent-highlight:        rgb(124 140 255 / 0.30);  /* multiply highlights on the page */
  --accent-highlight-strong: rgb(124 140 255 / 0.55);  /* the current search hit */
  --danger:  #ff6b6b;
  --success: #5fd39a;
  --warning: #f5c451;
  --warning-line: rgb(245 196 81 / 0.35);  /* the one honesty-notice border */

  --page-shadow: 0 0 0 1px var(--border-hairline);  /* pages get a hairline, not a drop shadow */
  --page-background: #ffffff;

  --font-sans: "Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace;
  --tracking-ui: 0.01em;      /* slight positive tracking on dark backgrounds */

  /* radius: 2 on the page · 4 small controls · 6 buttons, rows, menus, popovers ·
     10 contextual bars, palette, dialogs · capsule: the floating tool bar and the pen bar */
  --radius-page: 2px; --radius-1: 4px; --radius-2: 6px; --radius-3: 10px; --radius-round: 999px;
  --radius-capsule: var(--radius-round);
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px;

  /* motion: one curve; instant is drag feedback only; menus, popovers and the palette rise in,
     tooltips and dialogs enter from one scale */
  --duration-instant: 60ms; --duration-fast: 120ms; --duration-base: 180ms;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --enter-scale: 0.98;
  --rise-distance: 4px; --motion-rise: translateY(var(--rise-distance));  /* 0px under reduced motion */

  --focus-ring: 2px solid var(--accent); --focus-offset: 2px;
}
```

Rules:

- **One elevation, for floating chrome only.** Docked surfaces are flat: elevation is a
  tonal step plus a hairline. Floating chrome carries exactly one elevation token,
  `--elevation-float` (hairline ring, 1 px inner top highlight, one soft shadow), applied by
  the global `.glass` rule. No other shadow, glow or halo, and no side stripes: every other
  `box-shadow` is the page hairline, the inset hairline of a view switch or a 1px on-page
  ring. Under `prefers-contrast: more` and forced colours the elevation is dropped for the
  border. *Amended 2026-10-01 (M6, A1).*
- **Translucency only for floating chrome** (§2): tool bars, contextual bars, the palette,
  menus and popovers. Each surface composes one global `.glass` rule: a 50% tint over a
  backdrop that is blurred, colour-boosted and darkened, so a white page shows through as
  #3f4043 at worst. On glass, secondary and tertiary text use `--glass-text-secondary`,
  danger uses `--glass-danger`, and accent is never text; every text colour stays AA over a
  white page (primary 8.4:1, secondary 5.2:1, danger 4.6:1). The glass is opaque
  (`--glass-solid`, normal text ladder) without `backdrop-filter`, under
  `prefers-reduced-transparency` or `prefers-contrast: more`, and `Canvas` under forced
  colours. Docked panels, dialogs and tooltips stay opaque.
- **Color is for state**, never decoration: accent for focus/selection/primary action,
  danger for destructive, warning for honesty notices (repaired file, font substituted).
  Source-document color tags on the light table use a small desaturated palette, shown as
  6px dots next to a name.
- **State patterns.** "On" has two looks: a view switch is `--surface-3` with an inset
  hairline (Read | Arrange, page layout, signature tabs); an option choice is
  `--accent-muted` with no accent border (presets, segments, fit choices, search toggles).
  The active tool is a solid `--accent` fill with a `--surface-0` icon
  (`--tool-active-fill`, `--tool-active-ink`), at least 3:1 against the bar over any page;
  other option choices keep `--accent-muted`. *Amended 2026-10-01 (M6, A5).* Chrome
  toggles such as the panel buttons stay neutral (`--surface-active`). A current
  row (history step, current file, search hit, comment, field, redaction mark) is always
  `--accent-muted`, and tertiary text inside it steps up to secondary. Hover is one step,
  `--surface-hover`, including on small icon buttons.
- **Buttons.** Primary buttons compose the global `.primary-button`: accent fill with a
  `--surface-0` label, `--accent-hover` on hover, `--accent-pressed` while pressed, and
  `--surface-3` with `--text-disabled` when disabled (never the accent at reduced opacity).
  Secondary buttons are a hairline outline with the shared hover.
- **Honesty notices**: one recipe, a `--warning-line` hairline around the text, no tinted
  background and no side stripe.
- **On the page**: tools mark only what is under the pointer or has keyboard focus (the
  hovered line, image or field), with a 1px accent ring; images and the page are never
  tinted. Handles are page white with a 1.5px accent stroke. In-place editors are opaque
  page white with page ink, including the selected glyphs.
- **Icons**: one consistent 1.5px stroke set (Lucide or Phosphor), 16px in chrome, 20px in
  the tool bar.
- **Shape.** The floating tool bar and the pen bar are capsules (`--radius-capsule`, that is
  `--radius-round`). *Amended 2026-10-01 (M6, A6).*
- **Motion**: short, eased, disable-able. No bouncing, no springs in the chrome. Drag
  ghosts are slightly scaled and translucent. Menus, popovers and the palette rise in: they
  start 4 px nearer their anchor at opacity 0 and settle over `--duration-fast`
  (`--motion-rise`); reduced motion shows them at once. Tooltips and dialogs enter from
  `scale(var(--enter-scale))`; side dialogs and the toast slide in from their edge.
  *Amended 2026-10-01 (M6, A6).*
- **Typography**: 13px UI base, 12px secondary, 11px labels with tracking; numerals
  tabular in the status bar and page numbers.
- **The document canvas is never themed.** Pages render as authored; we do not invert or
  tint them. An optional "dim pages" comfort toggle reduces page brightness by
  compositing, not by filter-inverting.

## 4. Interaction principles

1. Every action has a keyboard path and appears in the command palette.
2. Selection is the primary noun; tools act on it. Esc always clears tool and selection.
3. Destructive actions are undoable, never confirmed with a dialog; the history panel is
   the safety net. Export is the only irreversible step and it runs a verification pass.
4. Honesty notices are inline (badge + expandable explanation), not modal.
5. Zero marketing surface: no banners, tips carousel, or upsells. Onboarding is an empty
   state with a drop target and three shortcuts.
6. Keyboard map on `?`; shortcut hints rendered as keycaps in menus and palette.

## 5. Accessibility

- The canvas is opaque to assistive tech; the DOM carries the semantics: light table as
  `role="grid"` with `aria-rowindex`/`aria-colindex` for virtualized cells and
  `aria-selected`; page canvas as `role="img"` with a descriptive label; a DOM text layer
  from glyph geometry for screen readers and find-in-page.
- Roving tabindex in tool bars and the grid; arrows move focus, Space selects, Enter opens,
  Delete removes, Alt+Arrows move pages, R / Shift+R rotate.
- Live region announcements for moves, rotations, long operations, export completion.
- Focus ring 2px accent on 2px offset, always visible on keyboard focus. Deliberate offset
  overrides: −2px for rows inside scrollers, 0 for inputs and menu items, 1px for segments,
  presets, hotspots and swatches, 3px (outline) for thumbnails, 4px for grid cells, and
  −2px for page layers.
- Target sizes ≥ 24×24; reduced motion respected; nothing conveyed by color alone.

## 6. Naming and brand

Working name: **pdf-editor** (repository name). A product name, wordmark and icon are
open items (see `DISCUSSION.md`). Brand should be a single glyph at small size, no
gradient, works in the tab bar at 16px.

## 7. Refinement pass (after M4)

**Done (2026-09-28).** The audit, the owner decisions (D1 to D16) and the before/after
screenshots are in [`docs/design/audit/`](design/audit/README.md); what each step changed,
with pixel diffs and measured contrast, is in
[`docs/design/audit/pass/RESULTS.md`](design/audit/pass/RESULTS.md). §2 and §3 describe the
result. The original brief follows.

Owner feedback after M3 (2026-09-27): the restraint is right, but the surfaces should read
as more translucent, and a few effects look wrong rather than quiet. The pass is scheduled
between M4 and M5 and covers:

- Translucency: floating surfaces (toolbars, menus, popovers, the contextual annotation
  bar) get a real frosted treatment (`backdrop-filter` with a tinted, low-alpha surface
  colour) over the stage, with an opaque fallback where the filter is unsupported or
  `prefers-reduced-transparency` is set. Panels docked to the frame stay opaque.
- Effect audit: every transition, shadow, focus ring, hover state and animation is listed
  with a screenshot and kept, toned down or removed. Candidates for removal are anything
  that draws attention to the chrome instead of the document. The owner reviews the list
  before changes land.
- Consistency: one radius scale, one border alpha, one motion curve; tokens updated in §3.
- Nothing structural: layout (§2) and interaction principles (§4) do not change.
