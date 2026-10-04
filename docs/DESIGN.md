# Design

**Status:** draft for discussion (2026-09-26), amended after M4 (§7), in M6 (§8) and in M8
(§9). This document defines intent and system; audits, measurements and screenshots are
under `docs/design/`.

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
│  ▤ 12 │ PAGES      │                 Read | Edit | Arrange                 │
│ Pages │ Pages|Bkm  │                                                       │
│  ⌕    │ ┌────┐     │                                                       │
│ Find  │ │    │ 1   │        document canvas  /  light table  /  Home       │
│  ☰ 3  │ └────┘     │                                                       │
│Review │ ┌────┐     │             ╭────────────────────────────╮            │  ← options tier
│  ⧉ 2  │ │    │ 2   │             ╰────────────────────────────╯            │
│ Files │ └────┘     │  ╭─────────────────────────────────────────────────╮  │
│       │            │  │     Select  Write  Text  Fill & sign  Redact    │  │  ← tool bar (glass)
│       │            │  ╰─────────────────────────────────────────────────╯  │
├───────┴────────────┴───────────────────────────────────────────────────────┤
│ Page 1 of 12 · Local only · No external requests                 100%  ⊟ ⊞ │  ← status bar
└────────────────────────────────────────────────────────────────────────────┘
```

- **Home is a view; a document is shown in Read, Edit or Arrange.** *Home* (the open files
  as cards, `0` or the app glyph) has no mode control. An open document is in **Read**
  (continuous pages, locked: nothing on the page can change) or **Edit** (the same canvas
  and scroll position, with the tools), and *Arrange* (the light table grid) is a view
  beside them, in either mode; *Compare* (two documents side by side) is a fourth segment
  only while a comparison is open. One control, **Read · Edit · Arrange**, an APG radio group
  with the view-switch "on" look: the Read segment carries a lock glyph and is named "Read,
  locked". Keys `1` Read, `2` Edit, `3` Arrange, `4` Compare (with none open, `4` starts
  one); `0`–`3` for the view or mode already shown do nothing and say nothing. The mode is a
  per-document flag kept for the session: a file opens in Read, Read and Edit never move
  the page, and Edit survives a trip to Arrange. On Home the glyph is current and no tab is
  selected; a tab click opens that document in its last view and mode. Selection carries
  across Read and Arrange. Chrome is never tinted by mode. *Amended 2026-10-04 (M8, A8).*
- **The stage runs under the docked chrome** in Read and Edit: the page viewport extends
  under the title bar, navigator, inspector and status bar, while fit, centring, the current
  page and scroll-into-view use the rectangle the panels leave free, re-fitted on every panel
  resize. At rest the page sits where it always did; while scrolling, pages pass under the
  opaque frame. Native stand-in scroll bars sit where the old ones were
  (`stage/stage-bleed.ts`, `stage/ScrollProxies.tsx`). Arrange, Home and Compare keep the
  stage's own box. *Added 2026-10-04 (M8, spec §7).*
- **Home** is the first view after two or more files are dropped on an empty app (or opened
  while Home shows), and the empty state when none is open. One card per open document in
  tab order, on `--surface-2`: first-page thumbnail, name, "6 pages · 6.1 KB", the tag dot.
  The header row counts files and pages and carries Open files…, Arrange pages, Compare
  (exactly two selected), Close and the primary **Combine N files** ("Combine all 3 files"
  with nothing selected, "Combine 2 files" with two; not shown for one). Combining always
  opens the Combine dialog, also when one card is dragged onto another ("Combine with
  report"); nothing combines without it. **Combine keeps its sources open.** It adds a new
  tab after the last source, titled "Combined – A + B" ("Combined – A + 2 more" for more
  files; the title follows the order until it is edited), as one history entry, "Combine 2
  files". An opaque toast at the bottom left, "Combined 2 files · Undo", stays while the
  combine is the latest history step and goes after 10 s, unless the pointer or the focus
  is on it. Arrange's "Merge all open documents" still replaces its inputs. The empty
  state is the same view with a drop target, one paragraph and three keycap shortcuts.
  *Amended 2026-10-01 (M6, A4); 2026-10-04 (M8 review).*
  **Recents** follow the cards, only when there are any: a "Recent" heading with a quiet
  "Clear recents", then up to 12 cards in one column, as wide as the open and drop card,
  newest first. Each card has a generic page glyph (no thumbnail), the name, "3 pages ·
  6.1 KB · 5 minutes ago" and, on the right and where it applies, an italic hint "Needs
  permission" or "Open again…". With no file open, the open and drop card comes first, at
  the top of the column, and the Recents follow; without Recents it sits centred. Files
  open right now are left out (their card is above). A card reopens the file through the
  browser's file handle where one was kept (Chromium's file picker, a dropped file), asking
  for permission first when the browser wants it, and opens it in Read; without a handle it
  opens the file dialog and says why in one line. Cards take roving focus (arrows, Home,
  End, Enter; Delete removes); a ⋯ button shown on hover or focus holds "Remove from
  recents". Only names, sizes, page counts and handles are kept, in IndexedDB on this
  device (`pdf-editor:recents:v1`), never the file's bytes or thumbnails. "Clear recents" is
  also in the palette and in the privacy popover; it is final, also for the stored copy
  after a write failure, and when the stored copy cannot be cleared the section stays with
  a one-line note and a Clear button to try again.
  *Amended 2026-10-04 (M8, A8; M8 review).*
- **Home's chrome is Home's own.** With files open, the navigator offers only **Files**
  (a document's Pages, Find or Review panel stays closed and its stored view is kept), and
  the status bar reads "N files" ("0 files" when empty), with no page, selection,
  signature or zoom readout. No tab looks selected on Home; the × of an unselected tab
  shows on hover or keyboard focus, not after a click. **Tabs** are as wide as their title,
  from 112 to 220 px, and truncate only when the strip is full. *Added 2026-10-04 (M8
  review).*
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
- **Floating tool bar** at bottom center over the document, a glass capsule. **In Read** it
  holds one **Edit** button (pencil and label, `aria-keyshortcuts="2"`, tooltip "Switch to
  Edit" with its keycap); pressing it enters Edit, shows the groups and moves the focus into
  them. **In Edit** it shows five labelled groups: **Select · Write · Text · Fill & sign ·
  Redact**. Select (V) is the idle tool: its chip leads the row and is the row's Tab stop,
  pressed while Select is armed, with the view-switch "on" look rather than the accent fill,
  so the bar carries no accent block at rest. Write holds the three pens and the
  Highlighter (§4.1), Eraser (Shift+E), Lasso (Q) and Shapes (R, O, L, A); Text holds Edit
  text (E), Text box (T), Note (N) and Image (I), and opening it arms Edit text, as opening
  Write arms the pen (a Text tool that is already armed stays armed); Fill & sign and
  Redact are as before.
  Picking a group morphs the capsule in place: the group's button becomes a chip with a
  chevron at the left end and the group's tools slide in beside it (one 160 ms movement,
  none under reduced motion); the chip returns to the row. The bar keeps its height,
  anchor and glass. Every tool keeps its one-letter shortcut, and arming a tool by its key
  or the palette shows its group. The text markups (Highlight, Underline U, Strikeout S,
  Squiggly) have no group: they live in the text selection bar and keep their keys and
  palette entries, and arming one by key shows the group row; pressing the key again
  opens that tool's options tier. Find, layout and fit live in the title bar and the
  palette; Crop, Rotate, Delete page and Arrange live in Arrange, the page context menu
  (in Edit) and the Document menu. Arrange shows only its own selection bar. *Amended
  2026-10-04 (M8, A9; M8 review).*
- **Text selection bar and page context menu.** A text selection gets a glass bar above its
  first line, on the page where it starts. In Read it offers **Copy**, **Edit text** and
  **Mark up…**. Edit text switches to Edit, clears the selection and opens the paragraph
  editor just inside the first selected glyph; Mark up… enters Edit, keeps the selection
  and turns the bar into the Edit one. In Edit, with Select armed, the bar offers
  Highlight, Underline, Strikeout, Squiggly and **Comment** (a new note at the end of the
  selection's first line). With another tool armed it does not show; Esc or a click
  elsewhere dismisses it. A right-click on a page, or Shift+F10 or the Menu key with the
  focus in the pages, opens the **page context menu** for that page. In Edit it holds
  "Edit text here" (first, with its E keycap), "Rotate page N left", "Rotate page N
  right", "Delete page N" (one undo step), "Crop…" and "Arrange". In Read it has no
  page-changing item:
  one muted row, "Switch to Edit to change pages" (lock glyph, the 2 keycap), which is not
  disabled and switches to Edit with "Edit mode" announced. Arrange still works in both
  modes. The browser keeps its own menu on selected text, in editors and on contextual
  bars. *Added 2026-10-04 (M8, A9); amended 2026-10-04 (M8 review).*
- **Creating does not select. A tool's options live with the tool**, in a second tier
  attached to the top of the bar (the tool's colour, opacity and width, as fit the tool),
  never over the page. **The tier opens only when the armed tool is pressed again**, by its
  button or its key; arming a tool, by any route, closes it. The armed button says "Press
  again for options" and the press announces "{tool} options". The pen's presets sit in
  the bar itself (§4.1). Changing them changes the tool, and the change is remembered.
  **A selection's options live with the selection**, which exists only after an explicit select (Select
  tool, a Review row, Tab) or a lasso: then a contextual bar appears above it
  (highlight/underline/comment for text; colour/stroke/opacity for an annotation). One-shot
  tools (stamp, signature image) return to the previous tool and leave the placed object
  unselected. *Amended 2026-10-01 (M6, A2); 2026-10-04 (M8 review).*
- **The bar gives way to a stroke.** While a drawing tool draws (pens, Highlighter,
  Eraser, Lasso, rectangle, ellipse, line, arrow), while the pen's eraser end or barrel
  button is down, or while a pen draws with Select armed ("Pen draws in Edit" on), and for
  1 s after, the tool bar and its tier fade to 20 % and ignore the pointer, so a stroke
  that crosses the bar goes on drawing on the page. Each surface fades alone, so its glass
  keeps its own backdrop; there is no transition under reduced motion. *Added 2026-10-04
  (M8 review).*
- **Document menu**, a labelled "Document" button in the title bar, with section headings
  and no disabled twins: Combine and split (Merge files…, Split…, Compare with…, Rotate
  pages…) · Add to pages (page numbers, header and footer, Bates numbering, watermark; a
  "Remove …" item appears only when there is something to remove) · Protect and sign ·
  Convert and export · Document (Document info…, bookmarks, repaired copy). *Amended
  2026-10-01 (M6, A4).* Every item stays available in Read: its dialogs have a preview and
  undo, and the lock guards against slips, not intent. An **Appearance ▸** submenu, one row
  before "About this app", holds three switches: Glass panels, Reduce transparency and Pen
  draws in Edit. Each shows a 14 px check box, empty with a border when off and an accent
  fill with a check when on, and is also a palette command; the palette titles carry the
  state ("Glass panels: on"). *Amended 2026-10-04 (M8, A10, A15; M8 review).*
- **Floating chrome is frosted glass; everything docked is opaque.** Glass: the floating
  tool bar and its options tier, the contextual bars (annotation, lasso, image, Arrange,
  text selection), the crop banner, the command palette, every menu (the page context menu
  among them), the pen preset editor, the privacy and link popovers, and the popovers
  anchored to the page (text-edit and paragraph editor headers, note popup, form notice,
  the "Switch to Edit to fill" notice, the one-time "Double-click to edit text" hint).
  Menus and popovers use the denser menu tier (§3). Opaque: the tab bar, navigator,
  inspector and status bar, Home and its cards, dialogs and side sheets (and their scrim),
  tooltips, the created-field properties popover and the update toast. Details and
  fallbacks are in §3. *Amended 2026-10-04 (M8).*
- **Glass panels (a trial, default off).** Behind the Glass panels setting (Document menu →
  Appearance, or the palette), the docked frame (title bar, navigator, inspector, status
  bar) becomes a denser glass that composites to exactly `--surface-1` over the canvas, so
  it changes only where a page passes under it (§3). With the setting on, all four docked
  surfaces blur in every view; there is no geometry gate. This is pending spike S2 on the
  owner's machine ([`research/14-glass-spike.md`](research/14-glass-spike.md)); until S2
  passes and the owner approves, the rule above stands: everything docked is opaque. If S2
  fails, the setting goes and the full-bleed stage and the menu tier stay. *Added
  2026-10-04 (M8, A15, pending S2); amended 2026-10-04 (M8 review).*
- **Command palette** (Cmd/Ctrl+K) lists every action with its shortcut, accepts
  arguments ("rotate 3-5 90", "go 42"), shows recents, and matches keywords of both UI
  languages without diacritics ("draw", "kalem" and "ciz" find the pen).
- **Status bar** carries the privacy indicator, zoom, and selection summary; on Home it
  reads "N files" instead.
- Hover states never shift layout; space is reserved. The stage keeps bottom padding so
  a page's last lines can scroll above the bar.

## 3. Tokens

Dark is the default and the primary theme. A light theme follows the same ladder inverted
and is an M9 item (ROADMAP), not a v1 blocker. The source of truth is
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
  --glass-filter: blur(28px) saturate(1.8) brightness(0.45);
  --glass-solid: var(--surface-2);      /* opaque fallback */
  --glass-text-secondary: #bcc0c6;      /* secondary and tertiary text on glass */
  --glass-text-disabled: #787c84;
  --glass-danger: #ffa0a0;
  /* menu glass (tier 3, M8): menus and popovers, .glass-menu with .glass; denser than the bar */
  --glass-menu: rgb(40 43 50 / 0.8);
  --glass-menu-filter: blur(32px) saturate(1.6) brightness(0.5);
  --glass-menu-solid: var(--glass-solid);
  /* frame glass (tier 2, M8): the docked frame, .glass-frame, only with "Glass panels" on;
     over the canvas it composites to --surface-1; alpha never below 0.78; no shadow */
  --glass-frame: rgb(29 31 37 / 0.8);
  --glass-frame-filter: blur(40px) saturate(1.4) brightness(0.6);
  --glass-frame-solid: var(--surface-1);
  --glass-frame-highlight: inset 0 1px 0 rgb(255 255 255 / 0.06);
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
  border. *Amended 2026-10-01 (M6, A1).* With Glass panels on, the docked frame's 1 px inner
  top highlight (`--glass-frame-highlight`) is the one other inset rule; docked glass has no
  shadow. *Amended 2026-10-04 (M8, A15, pending S2).*
- **Translucency only for floating chrome** (§2): tool bars, contextual bars, the palette,
  menus and popovers. Each surface composes one global `.glass` rule: a 66% tint over a
  backdrop that is blurred (28 px), colour-boosted and darkened (0.45), so a white page
  shows through as #47494d at worst (a lighter layer, not a slab; 0.45 is the brightest that
  keeps the armed tool's fill at 3:1 on it), and over the canvas the bar is #212328, 1.27:1
  against it (1.03:1 before M6): it reads as an object instead of sinking into the field.
  On glass, secondary and tertiary text use `--glass-text-secondary`, danger uses
  `--glass-danger`, and accent is never text; every text colour stays AA over every
  measured backdrop, the worst case being a white page (primary 7.30:1, secondary 4.94:1,
  danger 4.63:1, warning 5.54:1; amended 2026-10-01 after the M6 review, A4). The glass is opaque (`--glass-solid`, normal text
  ladder) without `backdrop-filter`, under `prefers-reduced-transparency` or
  `prefers-contrast: more`, and `Canvas` under forced colours; the ring and shadow stay
  under reduced transparency and go under more contrast. Docked panels, dialogs and
  tooltips stay opaque. `apps/web/src/styles/tokens.test.ts` asserts every ratio.
  **Menus and popovers** (every menu, the page context menu, the pen preset editor, the
  privacy and link popovers) compose `.glass-menu`, a denser tier for lists of text: an
  80 % tint over a backdrop blurred 32 px, saturated 1.6 and darkened to 0.5, #212329 over
  the canvas and #393c42 over a white page (primary 8.94:1, `--glass-text-secondary`
  6.05:1, `--glass-danger` 5.68:1, the accent 3.71:1). **Reduce transparency** is also an
  in-app switch (Document menu → Appearance; `[data-transparency='reduced']` on the root,
  since Safari reports no media query) and makes every tier solid with its ring, shadow and
  highlight kept, exactly as `prefers-reduced-transparency` does; the test keeps the two
  blocks identical. *Amended 2026-10-04 (M8, spec §7).*
- **Glass panels (trial, pending S2).** With the setting on (default off), the title bar,
  navigator, inspector and status bar compose `.glass-frame`: an 80 % tint over a backdrop
  blurred 40 px, saturated 1.4 and darkened to 0.6, which is exactly `--surface-1`
  (#181a1f) over the canvas and #36373c over a white page (primary 9.60:1, secondary
  6.50:1, danger 6.10:1, the accent 3.99:1). With the setting on, every one of the four
  surfaces carries the backdrop filter in every view; the 80 px geometry gate was removed
  after the M8 review. Over the canvas the blurred surface equals the solid token, so
  nothing changes at rest. The cost is measured in
  [`research/14-glass-spike.md`](research/14-glass-spike.md) §4.2: in Read it is as before,
  and in Arrange the median frame is unchanged while the slow tail (p95) rises. The
  floating bar's tier 1 stays as it is, because no lighter value passed the contrast tests
  (§4.3 there: a lighter backdrop takes the accent fill under 3:1, and a darker tint lets
  the bar sink into the canvas, below the 1.265:1 that `tokens.test.ts` requires). Filters
  never animate, there is no glass inside glass, and text on the frame uses the glass
  steps while the setting is on. Contrast is final for all
  three tiers over white, the canvas, `#808080` and black; frame rate, GPU memory and
  legibility on a 2020-class GPU at DPR 2 wait for the owner's machine
  ([`research/14-glass-spike.md`](research/14-glass-spike.md)). Without the owner's
  approval after S2, this rule does not replace "everything docked is opaque" (§2).
  *Added 2026-10-04 (M8, A15, pending S2); amended 2026-10-04 (M8 review).*
- **Chrome colour is for state; colour enters through content.** In the chrome, accent is
  for focus, selection, the armed tool and the primary action, danger for destructive,
  warning for honesty notices (repaired file, font substituted). Colour beyond that comes
  only from content: pen presets are dots of their real ink, and source documents keep
  their tag dots (a small desaturated palette, 6 px, always next to a name, on Home, the
  Files tab, the tabs and the light table). Chrome is never tinted; the accent stays its
  only colour. *Amended 2026-10-01 (M6, A3).*
- **Ink dots.** A pen preset is a dot of its real colour with the `--border-swatch` ring
  where the ink would not stand out from the well, 10, 13 or 16 px for widths of at most 1,
  at most 3 and over 3 pt, in a 32 px cell; the Highlighter is an 18 × 9 px capsule of its
  tint at full opacity (a highlighter mark). The four sit in one quiet well (half `--surface-1`, a
  hairline, round) so they read as one control. The armed preset gets a 2 px accent ring
  (26 px), not a fill, so its colour shows. *Amended 2026-10-02; 2026-10-04 (M8, A14).*
- **One ink palette.** One module, `apps/web/src/annotations/palette.ts`, feeds the pen
  presets, the preset editor, the contextual bar, the inspector, the options tier and the
  built-in stamps; `annotations/palette.test.ts` asserts every ratio and scans the
  annotation sources for stray colours. Writing inks pass 4.5:1 on white, accent inks 3:1;
  yellow is no longer an ink. Highlighter tints are drawn with Multiply at full opacity, so
  black text stays black on them in every viewer.

  | Role | Colours (contrast on white) |
  |---|---|
  | Writing inks | black `#1A1A1A` (17.40), blue `#1760EE` (5.32), red `#DB1C22` (5.00), green `#02853C` (4.75), purple `#8036D3` (6.20) |
  | Accent inks | orange `#E46910` (3.32), pink `#E02C8A` (4.29), cyan `#0891C9` (3.56) |
  | Highlighter tints | yellow `#FFEA00`, green `#8CF26B`, blue `#8FD3FF`, pink `#FF9AD5` (`#000` on each ≥ 10:1; our black ≥ 8.98:1) |

  Defaults: pens black 1.5 pt, blue 1.5 pt and red 2 pt, the Highlighter yellow 12 pt;
  underline blue, strikeout red, squiggly green, shapes red, text black, highlights and
  notes the yellow tint; the Draft, Approved and Confidential stamps blue, green and red.
  Stored presets and tool styles migrate once (`…:v1` → `…:v2`): an old default becomes the
  new default of its role, a translucent preset becomes the Highlighter with the nearest
  tint, a custom colour stays. Text black and the redaction fill stay pure black
  (`#000000`), which is not an ink. The accent `#7c8cff` is unchanged (ADR-0021 §4).
  *Added 2026-10-04 (M8, A14).*
- **Swatches and the range.** Colour swatches are 14 px dots (16 px in the inspector) in
  24 px targets, centres 24 px apart; the custom colour is a neutral dashed ring with a plus,
  filled with the colour once one is chosen, never a rainbow. A pen, a shape, text and
  every other ink get the eight inks; a highlight, a note, the Highlighter and any colour
  that is a tint get the four tints. A palette colour never shows as "custom" (*amended
  2026-10-04, M8, A14*). Every range input is the shared
  `ui/Range` control: a 2 px `--border-strong` track filled in `--accent-line` up to a 12 px
  `--text-primary` thumb (14 px on hover, the focus ring on the thumb), native under forced
  colours. *Added 2026-10-02.*
- **State patterns.** "On" has two looks: a view switch is `--surface-3` with an inset
  hairline (Home | Read | Arrange, page layout, signature tabs, the shown group's chip in
  the tool bar); an option choice is
  `--accent-muted` with no accent border (presets, segments, fit choices, search toggles).
  The active tool is a solid `--accent` fill with a `--surface-0` icon
  (`--tool-active-fill`, `--tool-active-ink`), at least 3:1 against the bar over any page;
  other option choices keep `--accent-muted`. *Amended 2026-10-01 (M6, A5).* The Select
  chip, pressed while the idle tool is armed, uses the view-switch look, not the accent
  fill. *Amended 2026-10-04 (M8, A9).* Chrome
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
  tinted. In Edit, idle hover over page text shows a 1 px `--accent-line` outline of the run
  after 400 ms, with no fill (§4.8). Handles are page white with a 1.5px accent stroke; a
  lasso selection carries one 1 px dashed accent box with eight 8 px resize handles and a
  rotation grip on a stem, each with a 24 px hit area pushed outwards so it never covers
  the selection. Text box and note editors are opaque page white with page ink, including
  the selected glyphs. **The paragraph editor draws the page's own glyphs**: PDFium's
  outlines of the file's font, on the real baselines with the full text matrix and in the
  span's colour, on a transparent canvas at device pixel ratio; lines before the edit are
  the page itself. Under the lines it rewrites it paints a page-white plate (a plate
  rendered without the paragraph is not built yet, so a coloured box under a rewritten line
  shows white until the exact preview settles, about 300 ms after typing pauses). Caret,
  selection and composition underline are ours; a substituted character is drawn in its
  bundled face. *Amended 2026-10-04 (M8, A11, A13).*
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
   with nothing armed, Esc on the tool bar returns to the group row. Esc never leaves
   Edit. It is a ladder: the first Esc disarms to Select, the second returns the bar to
   the group row, and the armed tool's tooltip ends "Esc: Select". *Amended 2026-10-04
   (M8, A10; M8 review).*
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
8. Read is locked; in Edit only the armed tool acts, and page text changes only through the
   paragraph editor. The policy is §4.8. *Added 2026-10-04 (M8, A10).*

### 4.1 The pen

Writing is never interrupted: a stroke never selects itself and never opens a bar or the
inspector, and the stroke never blinks: on pointer-up the committed shape is drawn on the
page's dry ink layer in the same task, and the page bitmap takes it over later in the task
that paints it.

- **Presets.** The Write group holds four presets as ink dots (§3): three pens, black
  1.5 pt, blue 1.5 pt and red 2 pt, and the **Highlighter**, yellow 12 pt; then Eraser,
  Lasso (Q) and Shapes. P arms the last writing pen (with the Highlighter active, the last
  pen rather than the Highlighter), H the Highlighter; each announces the preset ("Blue
  pen, 1.5 pt"), and from Read in one sentence with "Edit mode". Tapping a preset arms it;
  tapping the armed one, or pressing P again, opens its editor, a popover rising from the
  bar: for a pen the eight
  inks and a custom colour, width stops and a slider from 0.25 to 24 pt, and opacity;
  for the Highlighter the four tints and a custom colour and widths from 6 to 18 pt (stops
  6, 8, 10, 12, 15 and 18), with no opacity. Edits change that preset and are kept on the
  device (`pdf-editor:ui:pen-presets:v2`). Once a pen has reported pressure, the options
  tier and the preset editor carry one honesty line: other viewers that redraw ink
  themselves show it at one width. *Amended 2026-10-04 (M8, A12; M8 review).*
- **Width and one stroke model.** Pressure sets the width for a pen. A mouse draws the
  preset's width, constant; a finger, or a pen before it reports pressure, varies by speed
  within ±10 %. Preview and commit share one smoothed stroke model: the settled part of the
  preview is already the commit's smoothing (dedupe 0.5 pt, at least 1.5 CSS px for a
  mouse; centripetal Catmull-Rom), and only the newest points are raw, plus a prediction of
  at most 16 ms that is never committed; release adds only the simplification, so the
  committed outline lies within 0.5 device px of the last preview frame. Turns sharper than
  45° get round joins. The cursor is a dot of the preset's colour at its on-screen width
  (3–32 px) with a 1 px ring. The file keeps the centre lines and a constant `/BS /W`; the
  varying width lives in our appearance stream (ADR-0018). *Amended 2026-10-04 (M8, A12).*
- **Dry ink.** Committed strokes wait on a per-page canvas between the page bitmap and the
  annotation layer, drawn by us with the engine's outline function. The page re-renders
  when the pen is up and the main thread idle (at most 2 s) or the burst closes, never while
  a commit is in flight; when the bitmap with the strokes paints, they leave the dry layer
  in the same task. Thumbnails and other pages wait while a pen is down; an append to a
  burst writes the new path in place and re-renders only its box. *Added 2026-10-04 (M8,
  A12).*
- **The Highlighter.** Constant width, a tint at full opacity, Multiply; the preview
  multiplies too, so what is drawn is the result. On release, a stroke that runs along text
  becomes a **Highlight** annotation with quads from the first to the last glyph it covers
  on each line: a glyph counts when the stroke's band covers at least half its height, and
  the stroke snaps when at least 70 % of it runs along covered glyphs, within 35° of the
  reading direction, on every line it crosses. Otherwise it stays **free ink with
  Multiply** at constant width and joins bursts like a pen stroke. Alt forces free ink;
  Shift draws a level line; pages without text always give ink. H over a text selection
  highlights the selection in the Highlighter's tint. A snapped stroke is said, and listed
  in History, by its lines: "Highlighted 2 lines on page 3". Highlights move, erase and
  lasso like ink. *Added 2026-10-04 (M8, A12).*
- **Bursts.** Strokes written close together are one annotation: a stroke joins the open
  burst when it is on the same page with the same preset, starts within 1.5 s of the last
  pointer-up, lies within 36 pt of the burst's bounds, and the burst has fewer than 64
  paths. A burst is one history entry ("Pen on page 1 · 5 strokes"), one Review row ("Pen
  · 5 strokes") and one undo. It closes on a tool or group change, Esc, undo or redo, a
  selection, a page or document change, a preset edit or window blur.
- **Eraser.** A circle 6, 12, 24 or 48 px across (12 by default), shown as a hollow ring
  cursor, with two modes in its options tier: **Whole stroke** removes every path the circle
  touches, and **Partial** cuts ink paths where the circle crosses them, interpolating the
  widths at the cut and dropping pieces under 0.5 pt, by the lasso's split rule, so the
  annotation keeps its id and comment and goes with its last path. Highlighter ink and
  Highlight annotations are erased whole in both modes. One drag is one history entry. Mode
  and size are kept on the device (`pdf-editor:ui:eraser:v1`). *Amended 2026-10-04 (M8,
  spec §5.6).*
- **Hold to straighten.** Holding the pointer within 3 px for 500 ms while drawing turns the
  stroke into a straight line from the press to the pointer, which follows the pointer until
  release; the line thickens by 1 px for 120 ms as a cue (no cue under reduced motion). Shift
  snaps the line to 45° steps. *Added 2026-10-04 (M8, spec §5.6).*
- **Lasso.** Q draws a closed freehand region with a 1 px accent line. On release it takes
  every annotation it touches: ink paths, lines, arrows and polylines by their vertices and
  segments, polygons closed, rectangles by their edges and ellipses by 32 sampled points,
  text boxes, stamps and signature images by their rect, notes by their icon, text markups
  by any quad. Links, redaction marks and form widgets are never taken; locked and hidden
  ones are skipped. Taken paths and shapes are traced and areas tinted in the accent at the
  highlight alpha, inside one 1 px dashed accent box; the contextual bar names the mix ("3
  strokes, 1 arrow") and carries colour (not for stamps), opacity, width (disabled when
  nothing taken has one), font size for text boxes, a move grip and delete. Each edit
  across kinds is one history entry. Drag inside moves the selection, arrows nudge 1 pt
  (Shift: 10 pt), Delete removes it, Esc clears it and keeps the lasso armed. Eight handles
  resize about the opposite edge or corner (Shift on a corner keeps the aspect) and a grip
  rotates (Shift snaps to 15°): ink, lines, arrows, polylines and polygons transform
  exactly (ink widths × √(sx·sy)); rectangles and ellipses scale their rect; stamps keep
  their aspect; text boxes scale their font only under a uniform scale; notes and markups
  move. Under rotation, rectangles, ellipses, text boxes, notes and stamps orbit the centre
  unrotated, since PDF gives them no rotation, and the bar says "Stamps keep their
  orientation" once. From the keyboard the selection box takes the focus; there Shift+Arrow
  resizes by 1 pt instead of nudging, and Alt+Arrow rotates by 1°, each announced. Editing some paths of a
  burst splits them into a new Ink annotation in the same history entry; the original keeps
  its id and comment. *Amended 2026-10-04 (M8, A13).*
- **Pen buttons and fingers.** The pen's eraser end is a temporary eraser and its barrel
  button a temporary lasso, whatever tool is armed. Once a pen has been seen, one finger
  pans and two zoom, and touches during and just after a pen stroke or larger than 40 px
  are ignored. Before a pen is seen, a finger draws (phones). Holding Space pans in Read and
  Edit with any tool armed.

### 4.8 Read, Edit and the interaction policy

Principle 8 in full. *Added 2026-10-04 (M8, A10).*

- **Read is locked.** Allowed: scroll, zoom, layout, Find, select and copy text, links,
  form values, Review, History, Undo and Redo, the Document menu and Arrange. The page
  context menu has no page-changing item in Read: one row, "Switch to Edit to change
  pages", replaces Rotate, Delete and Crop. Arrange still works in both modes. Annotations
  cannot be selected, moved, resized, deleted or edited; notes and comments read in Review
  and the inspector, read-only. A click on a form field keeps its focus ring and shows
  "Switch to Edit to fill" with an **Edit** button (Tab from the field reaches it), never an
  implicit switch. A tool key switches to Edit and arms the tool, visibly and in one
  announcement ("Edit mode. Blue pen"), and changes nothing until the first stroke. U, S or
  H over selected text switch to Edit and keep the selection; marking needs a second press.
  A double-click selects a word. Adding, designing or clearing form fields and "Mark all
  matches" are offered only in Edit. Every mutation sits behind one store guard,
  `canEdit(documentId)`, which fails closed.
- **In Edit, only the armed tool acts.** Creating never selects; page text changes only
  through the paragraph editor.

  | Tool armed | What a press on the page does |
  |---|---|
  | Select (V) | Selects an annotation, starts a text selection, or clears; a **double-click on page text** with a mouse, or a pen used as a pointer, opens the paragraph editor with the caret at the point (never from touch, never from a pen that draws); a first plain click on page text shows the double-click hint |
  | Edit text (E) | Opens the paragraph editor at the point with one click; annotations are ignored |
  | Pens, Highlighter, Eraser, Lasso | Draw, erase or lasso over anything; text is never hit-tested |
  | Shapes, Text box, Note | Create, on text too |
  | Image (I) | Selects one of the page's images; nothing else is live |
  | Fill & sign, Redact | As before |

- **One hit order**: annotation → form widget → image → text run → text selection
  (`viewer/hit-order.ts`). Layer roots take no pointer; only the targets the armed tool can
  use are live (Read: text selection only; Select: annotations, form widgets, text
  selection; Edit text: text runs; Image: images; drawing tools: none).
- **Hover hint.** After 400 ms of idle mouse or pen hover over page text, with Select or
  Edit text armed, a faint run outline appears (§3), read from the text layer with no
  engine call; never from touch, never within 300 ms of a pen lift, never over an
  annotation, field or image, and not while the paragraph editor is open. Once per device a
  small glass hint says "Double-click to edit text", until the first double-click. With
  Select armed, a first plain click on page text (no drag) shows the same hint at once,
  below the clicked line; the next press clears it. It can cover the start of the next
  line.
- **Pen draws in Edit.** The setting turns on by itself when a pen is first seen, and can be
  set in Document menu → Appearance or the palette; while it is on, a pen with Select armed draws with the
  armed pen preset (the first pen while the Highlighter is armed), while Edit text always
  takes the pen as a pointer.
- **The paragraph editor.** It opens with a caret at the click, never a glyph selection;
  arrows cross lines, Enter inserts a line break, Mod+A selects the paragraph, a
  double-click a word, a triple-click all. There are no font, size or colour controls:
  typed text takes the style of the character before the caret, in the file's own font,
  and the paragraph rewraps from the edited line while earlier lines stay as they were.
  Its glass header carries only what applies: one honesty line naming the bundled face for
  characters the file's font lacks ("‘ğ’ uses Noto Sans because the original font in this
  file does not include it."), "Spacing tightened by N %", the overflow warning with the
  overlap marked on the canvas, the page-edge refusal, a ragged-line note, and an info
  popover. The header sits in the page margin beside the paragraph when 180 px are free
  (right first, then left); else above the floating bar, following the scroll; else below
  the paragraph. It never covers the text. "Join with next" and "Split here" are hidden.
  Leaving (Esc, a press outside, the focus leaving, a tool or mode change) commits a change
  as one history entry; with no change nothing happens. **An overlap is never committed
  silently.** Leaving with one keeps the editor open, keeps the overlap marked and offers
  three choices in the header: "Tighten to fit" (only when tightening the whole paragraph
  within the floors, −15 % word spacing and −5 % leading, makes it fit), "Let it overlap"
  and "Keep editing" (which takes the focus; Esc on the choice also keeps editing).
  Spacing is tightened automatically only on the lines the user rewrote, and the whole
  paragraph only on that button. Text that would cross the page edge is refused: "This
  text no longer fits on the page; shorten it or move content". Leaving through the Read
  lock, or by opening another paragraph, discards an overlap with an announcement. A draft
  scrolled off screen is kept and restored when the page returns. A paragraph that refuses
  paragraph mode opens the one-line editor on the clicked run and says why. With Edit text
  armed, the keyboard reaches one target per paragraph: Tab moves between paragraphs,
  Enter opens one, Esc returns to it.
- **What the paragraph editor keeps.** Typed text takes the style of the character before
  the caret, and untouched characters between several changes in one session keep their
  own font, size, colour and marked content; the writer checks this and fails closed
  rather than restyle them. A highlight or link over several lines follows its words quad
  by quad. Hard line breaks are kept: a line that is not the last and reaches under 85 % of
  the measure stays a line when the next word would have fitted after it, or when the next
  line is one short word (an address, a URL). The measure is bounded by an enclosing filled
  or stroked box, less the text's own inset, so an address in a shaded box does not rewrap
  out to the box's edge. The plate under rewritten lines is a dry-run render of the
  paragraph's area emptied, so coloured boxes and rules show through while typing, and the
  settled preview sits on the device pixels, with no shift on open or on settle. The hover
  outline under Select or Edit text shows the paragraph box, not the line. *Amended
  2026-10-04 (M8 review).*
- **Notes.** A note's popup saves its text on Esc and on a press outside it; only an
  empty new note is dropped, and Cancel is the one way to throw typed text away. It stays
  inside the visible area, flipping left or up near an edge. *Amended 2026-10-04 (M8
  review).*
- **Space** pans in both modes while the pages own the focus; a tap without a drag moves
  one screen. **Esc** clears the tool and the selection, then returns the bar to its group
  row; it never leaves Edit, and `1` is the way back to Read.

## 5. Accessibility

- The canvas is opaque to assistive tech; the DOM carries the semantics: light table as
  `role="grid"` with `aria-rowindex`/`aria-colindex` for virtualized cells and
  `aria-selected`; page canvas as `role="img"` with a descriptive label; a DOM text layer
  from glyph geometry for screen readers and find-in-page.
- Roving tabindex in tool bars and the grid; arrows move focus, Space selects, Enter opens,
  Delete removes, Alt+Arrows move pages, R / Shift+R rotate.
- Live region announcements for moves, rotations, long operations, export completion.
- Focus ring 2px accent on 2px offset, always visible on keyboard focus. Deliberate offset
  overrides: −2px for rows inside scrollers, 0 for inputs and menu items (−1px for the Find
  field), 1px for segments, presets and hotspots, −2px for swatches (inside their 24 px
  target), 3px (outline) for thumbnails, 4px for grid cells, −2px for page layers, and −2px
  inside the capsule bar and its options tier, so a focused chip never adds a second halo
  beside the armed preset's ring; the armed tool keeps 2px, as an inset ring would vanish in
  its accent fill. *Amended 2026-10-02.*
- Target sizes ≥ 24×24; reduced motion respected; nothing conveyed by color alone.
- Modes and Edit (M8): the lock glyph and the name "Read, locked" carry the mode without
  colour; a mode change is announced once, and a tool key in Read says the mode first ("Edit
  mode. Blue pen"). F6 reaches the Edit button in Read and the Select chip in Edit. With
  Edit text armed the keyboard reaches one target per paragraph (at least 24 × 24 px, named
  "Edit paragraph “…”"), not one per glyph run; the paragraph editor's hidden mirror is a
  multi-line textbox, "Paragraph on page 3", described by its header. The lasso's handles
  and grip have 24 px hit areas, and its selection box is a focusable group with
  `aria-keyshortcuts`. Every new state passes axe in English and Turkish, with Glass panels
  on and with Reduce transparency. *Amended 2026-10-04 (M8).*

## 6. Naming and brand

Product name: **Recto** (ADR-0015); "Recto PDF" is the descriptor where a search or a link
preview needs context. The repository is `recto` and the app lives at
`https://erendenizk.github.io/recto/` (ADR-0016). A wordmark and a final icon are open
items. Brand should be a single glyph at small size, no gradient, works in the tab bar at
16px.

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

## 9. Craft (M8)

**Built (2026-10-04)**, pending the owner's checks. The independent review ran on the same
day ([`DISCUSSION.md`](DISCUSSION.md) #31); its fixes are marked "M8 review" in §2–§4.8.
Owner feedback on the beta: everything works, nothing feels native yet. This pass amended §2–§5
with A8–A14 of the [spec](specs/craft.md) §2, as built: Home as a view and documents in Read
(locked), Edit or Arrange with keys `1`–`4` (A8); one Edit button in Read and five groups in
Edit, with the text selection bar and the page context menu (A9); Esc never leaving Edit
and the interaction policy of §4.8 (A10); the paragraph editor drawn from the page's own
glyphs (A11); three pens and the Highlighter, a constant mouse width, one stroke model and
dry ink (A12); a lasso that takes every kind, with resize and rotate (A13); one ink palette
(A14); Recents on Home, the partial eraser and hold-to-straighten. Two parts of A14 were not
built: tag dots stay desaturated and the accent's state alphas are unchanged. A15 (glass on
the docked frame, now with no geometry gate) is only a trial behind the Glass panels
setting, default off, pending spike S2 on the owner's machine
([`research/14-glass-spike.md`](research/14-glass-spike.md));
the menu glass tier, Reduce transparency and the full-bleed stage are in place for
everyone. What each work package delivered, and where it differs from the plan, is in the
spec's §15; the latency measurements are in
[`qa/ink-latency-baseline.md`](qa/ink-latency-baseline.md).
