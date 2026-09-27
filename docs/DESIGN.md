# Design

**Status:** draft for discussion (2026-09-26). This document defines intent and system;
visual explorations will be added under `docs/design/` as they are produced.

## 1. Intent

Quiet, dense, professional. The document is the only bright thing on screen; the
application recedes into a near-black field. Nothing glows. Hierarchy comes from tonal
steps and hairline borders, not from shadows or saturated color. The product should feel
closer to Linear, Raycast and Apple Preview than to Acrobat or any "PDF tools" site.

References studied in `research/02-market-and-ux.md` §5: Linear (surface ladder, single
accent), Raycast (no shadows, hairline borders, keycap shortcut hints), Vercel Geist
(neutrals only, accent as punctuation), Apple Preview (thumbnail sidebar you drag pages
into), tldraw (canvas app layout, selection-driven style panel), Excalidraw (island
containers; and the anti-pattern of CSS-invert dark mode).

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
- **Floating tool bar** at bottom center over the document is the one translucent
  surface. It shows the tools of the current mode; a second, contextual bar appears
  above a selection (highlight/underline/comment for text; rotate/delete/extract for
  pages; color/stroke/opacity for an annotation).
- **Command palette** (Cmd/Ctrl+K) lists every action with its shortcut, accepts
  arguments ("rotate 3-5 90", "go 42"), shows recents.
- **Status bar** carries the privacy indicator, zoom, and selection summary.
- Hover states never shift layout; space is reserved.

## 3. Tokens (draft)

Dark is the default and the primary theme. A light theme follows the same ladder inverted
and is a v1.x item, not a v1 blocker.

```css
:root {
  /* surface ladder: canvas → panel → raised → overlay */
  --surface-0: #0a0b0d;   /* app canvas */
  --surface-1: #101215;   /* panels */
  --surface-2: #16181c;   /* raised: cards, inputs */
  --surface-3: #1c1f24;   /* popovers, menus */
  --glass:     rgb(16 18 21 / 0.72);  /* floating chrome over the document, + blur 16px */

  --border-hairline: rgb(255 255 255 / 0.08);
  --border-strong:   rgb(255 255 255 / 0.14);

  --text-primary:   #e6e7ea;
  --text-secondary: #9a9ea6;
  --text-tertiary:  #6b7078;
  --text-disabled:  #4a4e55;

  --accent:        #7c8cff;   /* one accent; used for focus, selection, primary action */
  --accent-muted:  rgb(124 140 255 / 0.16);
  --danger:        #ff6b6b;
  --success:       #5fd39a;
  --warning:       #f5c451;

  --page-shadow: 0 0 0 1px rgb(255 255 255 / 0.06);  /* pages get a hairline, not a drop shadow */

  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;   /* or Geist Sans */
  --font-mono: "JetBrains Mono", ui-monospace, monospace;      /* or Geist Mono */
  --tracking-ui: 0.01em;      /* slight positive tracking on dark backgrounds */

  --radius-1: 4px; --radius-2: 6px; --radius-3: 10px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px;
  --duration-fast: 120ms; --duration-base: 180ms;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
}
```

Rules:

- **No drop shadows** on working surfaces; elevation is a tonal step plus a hairline.
- **Translucency only for floating chrome** over the document (tool bars, palette,
  contextual bars). Every glass surface has a solid fallback and a 1px border and must pass
  WCAG AA against both a white page and the dark canvas. Honor
  `prefers-reduced-transparency` and `prefers-contrast`.
- **Color is for state**, never decoration: accent for focus/selection/primary action,
  danger for destructive, warning for honesty notices (repaired file, font substituted).
  Source-document color tags on the light table use a small desaturated palette.
- **Icons**: one consistent 1.5px stroke set (Lucide or Phosphor), 16px in chrome, 20px in
  the tool bar.
- **Motion**: short, eased, disable-able. No bouncing, no springs in the chrome. Drag
  ghosts are slightly scaled and translucent.
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
- Focus ring 2px accent on 2px offset, always visible on keyboard focus.
- Target sizes ≥ 24×24; reduced motion respected; nothing conveyed by color alone.

## 6. Naming and brand

Working name: **pdf-editor** (repository name). A product name, wordmark and icon are
open items (see `DISCUSSION.md`). Brand should be a single glyph at small size, no
gradient, works in the tab bar at 16px.

## 7. Refinement pass (after M4)

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
