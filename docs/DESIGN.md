# Design

**Status:** draft for discussion (2026-09-26), amended after M4 (§7) and in M6 (§8). This
document defines intent and system; audits, measurements and screenshots are under
`docs/design/`.

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
┌────────────────────────────────────────────────────────────────────────────┐
│ ● report.pdf × invoice.pdf × +           ⌘K Search commands…  Document ⤓ ◨ │  ← title/tab bar
├───────┬────────────┬───────────────────────────────────────────────────────┤
│  ▤ 12 │ PAGES      │                     Read | Arrange                    │
│ Pages │ Pages|Bkm  │                                                       │
│  ⌕    │ ┌────┐     │                                                       │
│ Find  │ │    │ 1   │        document canvas  /  light table  /  Home       │
│  ☰ 3  │ └────┘     │                                                       │
│Review │ ┌────┐     │             ╭────────────────────────────╮            │  ← options tier
│  ⧉ 2  │ │    │ 2   │             ╰────────────────────────────╯            │
│ Files │ └────┘     │  ╭─────────────────────────────────────────────────╮  │
│       │            │  │ Read  Mark up  Draw  Fill & sign  Pages  Redact │  │  ← tool bar (glass)
│       │            │  ╰─────────────────────────────────────────────────╯  │
├───────┴────────────┴───────────────────────────────────────────────────────┤
│ Page 1 of 12 · Local only · No external requests                 100%  ⊟ ⊞ │  ← status bar
└────────────────────────────────────────────────────────────────────────────┘
```

- **Four views of the center pane**, one mental model: *Home* (the open files as cards),
  *Read* (continuous pages), *Arrange* (light table grid) and *Compare* (two documents side
  by side). One key each: `0`, `1`, `2`, `3`; the app glyph also goes Home. Selection
  carries across Read and Arrange. The view switch shows Home only while it is shown and
  Compare only while a comparison is open.
- **Home** is the first view after two or more files are dropped on an empty app (or opened
  while Home shows), and the empty state when none is open. One card per open document in
  tab order, on `--surface-2`: first-page thumbnail, name, "6 pages · 6.1 KB", the tag dot.
  The header row counts files and pages and carries Open files…, Arrange pages, Compare
  (exactly two selected), Close and the primary **Combine N files** ("Combine all 3 files"
  with nothing selected, "Combine 2 files" with two; not shown for one). Combining always
  opens the merge dialog, also when one card is dragged onto another ("Combine with
  report"); nothing merges without it. The empty state is the same view with a drop target,
  one paragraph and three keycap shortcuts. *Amended 2026-10-01 (M6, A4).*
- **Navigator** on the left: four labelled tabs, an icon with an 11 px label under it and a
  count badge (tabular numerals, hidden at 0): **Pages** (thumbnails, with a Pages ·
  Bookmarks switch for the outline), **Find**, **Review** (comments, redaction marks and
  form fields in one list grouped by page, with filter chips and counts) and **Files** (one
  compact row per open file: tag dot, name, "6 pages · 6.1 KB", close). Each panel leads
  with content; settings appear only where they apply (the comment author is asked once,
  inline; redaction and form controls show only in their filter). Compare's Changes tab
  appears only in the Compare view and comes last, so the other four never move. Panels
  remember their state. *Amended 2026-10-01 (M6, A4).*
- **Inspector** on the right is closed by default and opens only from its title bar toggle
  (Mod+Alt+B); the choice is remembered. It holds Selection and History. Name, size, pages,
  dates, metadata, password and diagnostics live in the **Document info** sheet (Document
  menu, palette). *Amended 2026-10-01 (M6, A4).*
- **Floating tool bar** at bottom center over the document, a glass capsule. At rest it
  shows six labelled task groups: Read · Mark up · Draw · Fill & sign · Pages · Redact.
  Picking a group morphs the capsule in place: the group's button becomes a chip with a
  chevron at the left end and the group's tools slide in beside it (one 160 ms movement,
  none under reduced motion); the chip returns to the row. The bar keeps its height,
  anchor and glass. Every tool keeps its one-letter shortcut, and arming a tool by its key
  or the palette shows its group. Arrange shows only its own selection bar. *Amended
  2026-10-01 (M6, A4).*
- **Creating does not select. A tool's options live with the tool**, in a second tier
  attached to the top of the bar while the tool is armed (the tool's colour, opacity and
  width, as fit the tool), never over the page; the pen's presets sit in the bar itself
  (§4.1). Changing them changes the tool, and the change is remembered. **A selection's
  options live with the selection**, which exists only after an explicit select (Select
  tool, a Review row, Tab) or a lasso: then a contextual bar appears above it
  (highlight/underline/comment for text; colour/stroke/opacity for an annotation). One-shot
  tools (stamp, signature image) return to the previous tool and leave the placed object
  unselected. *Amended 2026-10-01 (M6, A2).*
- **Document menu**, a labelled "Document" button in the title bar, with section headings
  and no disabled twins: Combine and split (Merge files…, Split…, Compare with…, Rotate
  pages…) · Add to pages (page numbers, header and footer, Bates numbering, watermark; a
  "Remove …" item appears only when there is something to remove) · Protect and sign ·
  Convert and export · Document (Document info…, bookmarks, repaired copy). *Amended
  2026-10-01 (M6, A4).*
- **Floating chrome is frosted glass; everything docked is opaque.** Glass: the floating
  tool bar and its options tier, the contextual bars (annotation, lasso, image, Arrange),
  the crop banner, the command palette, every menu, the pen preset editor, the privacy and
  link popovers, and the popovers anchored to the page (text-edit header, note popup, form
  notice). Opaque: the tab bar, navigator, inspector and status bar, Home and its cards,
  dialogs and side sheets (and their scrim), tooltips, the created-field properties
  popover and the update toast. Details and fallbacks are in §3.
- **Command palette** (Cmd/Ctrl+K) lists every action with its shortcut, accepts
  arguments ("rotate 3-5 90", "go 42"), shows recents, and matches keywords of both UI
  languages without diacritics ("draw", "kalem" and "ciz" find the pen).
- **Status bar** carries the privacy indicator, zoom, and selection summary.
- Hover states never shift layout; space is reserved. The stage keeps bottom padding so
  a page's last lines can scroll above the bar.

## 3. Tokens

Dark is the default and the primary theme. A light theme follows the same ladder inverted
and is an M8 item, not a v1 blocker. The source of truth is
`apps/web/src/styles/tokens.css`; this is its shape after the experience redesign (M6;
measurements in [`design/audit-2026-10/V1-RESULTS.md`](design/audit-2026-10/V1-RESULTS.md)).

```css
:root {
  /* surface ladder: canvas → panel → raised → overlay; hover and active are white washes.
     The canvas sits darkest, so the page and the floating bar stand out and the panels
     read as a frame (canvas → panel 1.14:1, ΔL* 6.9) */
  --surface-0: #08090b;   /* canvas, Home background */
  --surface-1: #181a1f;   /* panels, title bar, status bar, navigator */
  --surface-2: #1f2227;   /* raised: cards, inputs, --glass-solid */
  --surface-3: #272a30;   /* view-switch "on", disabled primary buttons */
  --surface-hover:  rgb(255 255 255 / 0.045);
  --surface-active: rgb(255 255 255 / 0.075);
  --scrim: rgb(5 6 8 / 0.56);

  /* glass: floating chrome over the document (the global .glass rule) */
  --glass: rgb(48 51 58 / 0.66);
  --glass-filter: blur(28px) saturate(1.8) brightness(0.36);
  --glass-solid: var(--surface-2);      /* opaque fallback */
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
  --text-tertiary:  #8f949c;  /* ≥ 4.71:1 on surface-0..3 (the draft's #6b7078 was 3.8:1) */
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

  /* source-document tags: small, desaturated, always next to a file name */
  --tag-0: #7db3a4; --tag-1: #c8a46e; --tag-2: #c58b9d;  /* sage, sand, rose */
  --tag-3: #9aa8ba; --tag-4: #a6b27c; --tag-5: #c7967a;  /* steel, olive, clay */

  --page-shadow: 0 0 0 1px var(--border-hairline);  /* pages get a hairline, not a drop shadow */
  --page-background: #ffffff;

  --font-sans: "Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace;
  --tracking-ui: 0.01em;      /* slight positive tracking on dark backgrounds */

  /* radius: 2 on the page · 4 small controls · 6 buttons, rows, menus, popovers ·
     10 contextual bars, palette, dialogs, cards · capsule: the floating tool bar, its
     options tier and the pen bar */
  --radius-page: 2px; --radius-1: 4px; --radius-2: 6px; --radius-3: 10px; --radius-round: 999px;
  --radius-capsule: var(--radius-round);
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px;

  /* motion: one curve; instant is drag feedback only; menus, popovers and the palette rise in,
     tooltips and dialogs enter from one scale */
  --duration-instant: 60ms; --duration-fast: 120ms; --duration-base: 180ms;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --enter-scale: 0.98;
  --rise-distance: 4px;  /* 0px under reduced motion */
  --motion-rise: translateY(var(--rise-distance));

  --rail-width: 64px;   /* the navigator: icon, 11 px label, count */
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
  menus and popovers. Each surface composes one global `.glass` rule: a 66% tint over a
  backdrop that is blurred (28 px), colour-boosted and darkened (0.36), so a white page
  shows through as #3f4145 at worst, and over the canvas the bar is #212328, 1.27:1
  against it (1.03:1 before M6): it reads as an object instead of sinking into the field.
  On glass, secondary and tertiary text use `--glass-text-secondary`, danger uses
  `--glass-danger`, and accent is never text; every text colour stays AA over every
  measured backdrop, the worst case being a white page (primary 8.27:1, secondary 5.14:1,
  danger 4.51:1, warning 6.28:1). The glass is opaque (`--glass-solid`, normal text
  ladder) without `backdrop-filter`, under `prefers-reduced-transparency` or
  `prefers-contrast: more`, and `Canvas` under forced colours; the ring and shadow stay
  under reduced transparency and go under more contrast. Docked panels, dialogs and
  tooltips stay opaque. `apps/web/src/styles/tokens.test.ts` asserts every ratio.
- **Chrome colour is for state; colour enters through content.** In the chrome, accent is
  for focus, selection, the armed tool and the primary action, danger for destructive,
  warning for honesty notices (repaired file, font substituted). Colour beyond that comes
  only from content: pen presets are dots of their real ink, and source documents keep
  their tag dots (a small desaturated palette, 6 px, always next to a name, on Home, the
  Files tab, the tabs and the light table). Chrome is never tinted; the accent stays its
  only colour. *Amended 2026-10-01 (M6, A3).*
- **Ink dots.** A pen preset is a dot of its real colour with the `--border-swatch` ring,
  8, 11 or 14 px for widths ≤ 1, ≤ 3 and > 3 pt, in a 28 px target; a preset below full
  opacity is a short capsule (a highlighter mark). The armed preset gets a 2 px accent
  ring, not a fill, so its colour shows.
- **State patterns.** "On" has two looks: a view switch is `--surface-3` with an inset
  hairline (Home | Read | Arrange, page layout, signature tabs, the shown group's chip in
  the tool bar); an option choice is
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
- **Shape.** The floating tool bar, its options tier and the pen bar are capsules
  (`--radius-capsule`, that is `--radius-round`); their buttons are round, concentric with
  the capsule's ends. Home cards use `--radius-3`. *Amended 2026-10-01 (M6, A6).*
- **Motion**: short, eased, disable-able. No bouncing, no springs in the chrome. Drag
  ghosts are slightly scaled and translucent. Menus, popovers and the palette rise in: they
  start 4 px nearer their anchor at opacity 0 and settle over `--duration-fast`
  (`--motion-rise`); reduced motion shows them at once. The options tier rises from the
  bar's top edge the same way. A group change morphs the bar in one 160 ms movement on the
  `--ease-out` curve, the capsule's width following; none under reduced motion. Tooltips
  and dialogs enter from `scale(var(--enter-scale))`; side dialogs and the toast slide in
  from their edge. *Amended 2026-10-01 (M6, A6).*
- **Typography**: 13px UI base, 12px secondary, 11px labels with tracking; numerals
  tabular in the status bar and page numbers.
- **The document canvas is never themed.** Pages render as authored; we do not invert or
  tint them. An optional "dim pages" comfort toggle reduces page brightness by
  compositing, not by filter-inverting.

## 4. Interaction principles

1. Every action has a keyboard path and appears in the command palette.
2. Selection is the primary noun; tools act on it. Esc always clears tool and selection;
   with nothing armed, Esc on the tool bar returns to the group row.
3. Creating does not select. A tool's options live with the tool and set the next object;
   a selection's options live with the selection, which only an explicit select or a lasso
   makes. Nothing opens on its own after a stroke, a shape or a placed stamp.
   *Amended 2026-10-01 (M6, A2).*
4. Destructive actions are undoable, never confirmed with a dialog; the history panel is
   the safety net. Export is the only irreversible step and it runs a verification pass.
5. Honesty notices are inline (badge + expandable explanation), not modal.
6. Zero marketing surface: no banners, tips carousel, or upsells. Onboarding is an empty
   state with a drop target and three shortcuts.
7. Keyboard map on `?`; shortcut hints rendered as keycaps in menus and palette.

### 4.1 The pen

Writing is never interrupted: a stroke never selects itself and never opens a bar or the
inspector, and the live preview stays until the committed stroke has been painted, so it
does not blink.

- **Presets.** The Draw group holds four presets as ink dots (§3): black 1.5 pt, blue
  1.5 pt, red 2 pt and a yellow 12 pt highlighter at 40 %, then Eraser, Lasso (Q) and
  Shapes. P arms the last used preset. Tapping a preset arms it; tapping the armed one
  opens its editor, a popover rising from the bar (eight swatches and a custom colour,
  width stops and a slider from 0.25 to 24 pt, opacity). Edits change that preset and are
  kept on the device. Once a pen has reported pressure, the options tier carries one
  honesty line: other viewers that redraw ink themselves show it at one width.
- **Width.** Pressure sets the width for a pen; speed for a mouse or a finger. Preview
  and commit use the same outline function, so the shape does not move on release. The
  file keeps the centre lines and a constant `/BS /W`; the varying width lives in our
  appearance stream (ADR-0018).
- **Bursts.** Strokes written close together are one annotation: a stroke joins the open
  burst when it is on the same page with the same preset, starts within 1.5 s of the last
  pointer-up, lies within 36 pt of the burst's bounds, and the burst has fewer than 64
  paths. A burst is one history entry ("Pen on page 1 · 5 strokes"), one Review row ("Pen
  · 5 strokes") and one undo. It closes on a tool or group change, Esc, undo or redo, a
  selection, a page or document change, a preset edit or window blur. The eraser removes
  the path under it, and the annotation with its last path.
- **Lasso.** Q draws a closed freehand region with a 1 px accent line. On release it takes
  every ink path it touches (a point inside, or a segment crossing the line); locked and
  hidden inks are skipped, other annotation kinds are left to the Select tool. The taken
  paths are traced in the accent at the highlight alpha, and the contextual bar above
  them says "3 strokes" and carries colour, opacity, width, a move grip and delete. Drag
  inside moves them, arrows nudge 1 pt (Shift: 10 pt), Delete removes them, Esc clears the
  selection and keeps the lasso armed. Editing some paths of a burst splits them into a
  new Ink annotation in the same history entry; the original keeps its id and comment.
- **Fingers and palms.** Once a pen has been seen, one finger pans and two zoom, and
  touches during and just after a pen stroke or larger than 40 px are ignored. Before a
  pen is seen, a finger draws (phones).

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

## 8. Experience redesign (M6)

**Done (2026-10-01), pending the accessibility pass and review.** Owner feedback after M5:
the features are right, the app is too complicated. Unlike §7 this pass was structural, so
§2 was redrawn (Home, the four-tab navigator, the closed inspector, the task-grouped bar,
the sectioned Document menu) and §3 and §4 amended (A1–A6 of the
[spec](specs/experience-redesign.md) §2; A7 is in `specs/viewer-annotations.md`). The audit
that started it and what changed for each friction item are in
[`design/experience-audit-2026-10.md`](design/experience-audit-2026-10.md); the token and
contrast measurements in
[`design/audit-2026-10/V1-RESULTS.md`](design/audit-2026-10/V1-RESULTS.md). The frames in
`design/screenshots/` are written by the end-to-end specs with `CAPTURE_SCREENSHOTS=1`
(Chromium); the `m6-*` frames show the new surfaces.
