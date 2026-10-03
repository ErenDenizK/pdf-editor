---
title: "Research: translucent chrome, document modes and palette vividness"
date: 2026-10-03
status: snapshot
---

> Research snapshot gathered on 2026-10-03. Apple's guidance was read from the JSON data behind
> the Human Interface Guidelines (`developer.apple.com/tutorials/data/…`); Microsoft's from the
> `MicrosoftDocs/windows-dev-docs` and `microsoft/microsoft-ui-xaml` sources on GitHub; browser
> support from MDN `browser-compat-data` (`main`, read that day); the tldraw palette from the
> `@tldraw/editor` and `tldraw` 5.5.2 npm tarballs; Excalidraw's from its `main` branch; FigJam's
> from Figma's `mcp-server-guide` repository. learn.microsoft.com, fluent2.microsoft.design,
> figma.com, support.goodnotes.com, pdfexpert.com, support.microsoft.com, apple.com and several
> blogs were blocked by this session's egress proxy, so claims about those products rest on
> search-result abstracts or established knowledge and are marked as such. All contrast ratios
> and OKLCH values were computed for this document with the same sRGB compositing model that
> the comments in `apps/web/src/styles/tokens.css` use (backdrop × brightness, then the tint
> laid over it); OKLCH uses Ottosson's published matrices. No other file was changed.

# Glass, modes and palette: research for the next design pass

## 0. Verdict

- **Glass can go wider, but only where something moves behind it.** Over the uniform
  `--surface-0` canvas, any glass composites to a single flat colour that looks exactly like an
  opaque panel. So translucent side panels, title bar and status bar need the stage to **run
  full-bleed underneath them**: pages scroll under the title bar and slide under the panels when
  zoomed or panned. This is how Apple's Liquid Glass works, with content that "scroll[s] and
  peek[s] through from beneath". Macs and Arc get their translucent sidebars from the desktop
  behind the window, which a web page can never sample.
- **Three tiers, one rule.** Each tier caps the backdrop's luminance with `brightness()` before
  the tint goes on. That makes a white page the provable worst case, so the contrast tests stay
  deterministic and no adaptive sampling is needed (§3). The side-panel tier is tuned to
  composite to exactly `--surface-1` over the canvas. Blur can then be switched off whenever no
  page is near a panel (§4.2), which removes most of the GPU cost.
- **What stays opaque:** text inputs, in-place editors, dialogs and their scrim, tooltips,
  toasts, Home cards and thumbnails. Recto also needs an **in-app "Reduce transparency"**
  setting: Safari does not implement `prefers-reduced-transparency`, and Firefox ships it only
  behind a flag (§4.4).
- **Modes:** Home stays a view. A document has **Read ⇄ Edit**, and Arrange is a view. Show
  these as one segmented control, **Read · Edit · Arrange**, with a lock glyph in Read. Read is
  truly locked: no tool can be armed, the pen never marks, and fields do not take input. Edit is
  today's six-group bar under a strict policy: only the armed tool creates, page text changes
  only through the Edit-text tool, and double-click never creates (§6). Do not tint the chrome
  by mode.
- **Ink:** the current presets are Material 600-ish tones. Their lightness ranges from 0.49 to
  0.88, they use 76–100 % of the available chroma, and yellow and orange are too light to
  write with (1.4:1 and 2.4:1 on white). §8 proposes eight inks in two lightness bands, each
  near the gamut edge, plus four highlighters drawn with Multiply at 40 %.
- **Accent:** `#7c8cff` already sits on the sRGB gamut boundary for its lightness and hue
  (C 0.169 out of a possible 0.170), so a more saturated colour of the same hue has to be
  darker. Darker breaks the armed tool's 3:1 against the glass unless the glass gets darker
  too. Keep it, or A/B test `#7584fe` with glass brightness 0.40 (§9).

---

## 1. What platforms say about materials

| System | Translucent material | Where it is allowed | Where it is not | Accessibility fallback |
|---|---|---|---|---|
| Apple, 2025 (Liquid Glass) | "Regular" (blurs and adjusts luminosity) and "clear" (highly translucent) | "A distinct functional layer for controls and navigation elements — like tab bars and sidebars — that floats above the content layer". Use regular "when components have a significant amount of text, such as alerts, sidebars, or popovers". | "Don't use Liquid Glass in the content layer"; "use Liquid Glass effects sparingly" — [HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | Reduce Transparency puts darker backgrounds behind translucent areas; Increase Contrast keeps translucency but adds borders — [MacRumors](https://www.macrumors.com/how-to/ios-reduce-transparency-liquid-glass-effect/). iOS 26.1 added a Clear/Tinted preference — [Yahoo Tech](https://tech.yahoo.com/ai/apple-intelligence/articles/ios-26-1-beta-4-100125001.html) (abstract) |
| Apple, standard materials | Ultra-thin, thin, regular, thick, with "vibrant" label, fill and separator colours designed for each | Content-layer differentiation | Quaternary vibrancy on thin materials ("contrast is too low") | Same settings |
| Microsoft Acrylic | Blur, exclusion blend, tint and luminosity, noise | "Transient UI elements… context menus, flyouts, non-modal popups, light-dismiss panes" | "For vertical panes or surfaces that help section off content of your app, we recommend you use an opaque background instead of acrylic"; "Don't place multiple acrylic panes next to each other" — [acrylic.md](https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/apps/design/style/acrylic.md) | Solid fallback under Battery Saver, with transparency off, on low-end hardware and in inactive windows (same source) |
| Microsoft Mica | **Opaque**; "only samples the desktop wallpaper once" | "Long-lived windows", as the app's base layer | Not for individual UI elements: "Don't apply backdrop material to a UI element" — [mica.md](https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/apps/design/style/mica.md) | High Contrast colours; solid fallback |
| Material 3 | None. Elevation is tonal surface containers plus shadow | — | — | — (established knowledge; [m3.material.io/styles/elevation](https://m3.material.io/styles/elevation/overview)) |

Four lessons carry over to Recto.

1. **Luminosity is clamped, colour passes through.** WinUI's default dark acrylic is
   `TintColor #2C2C2C, TintOpacity 0.15, TintLuminosityOpacity 0.96`
   ([AcrylicBrush_themeresources.xaml](https://github.com/microsoft/microsoft-ui-xaml/blob/main/controls/dev/Materials/Acrylic/AcrylicBrush_themeresources.xaml)).
   Only 15 % of the tint's colour is applied, but the luminosity layer is 96 % opaque, so hue
   shows through while brightness barely moves. Recto's `brightness(0.45)` is the web
   equivalent and should stay in every tier.
2. **Bigger surfaces get denser.** Apple: "Liquid Glass appears more opaque in larger elements
   like sidebars to preserve legibility" and "for smaller elements like toolbars… the system can
   adapt… between a light and dark appearance"
   ([HIG Color](https://developer.apple.com/design/human-interface-guidelines/color)).
3. **Always-visible panels are the contested case.** Microsoft says opaque; Apple says glass,
   but in its regular, more opaque form and with content running underneath. Figma tried
   floating panels in UI3 and went back to fixed ones because "designs seemed to peek out from
   behind them in a distracting way", they cramped the canvas and slowed people down
   ([Figma blog](https://www.figma.com/blog/our-approach-to-designing-ui3/), via search
   abstract; [Bits Kingdom](https://bitskingdom.com/blog/figma-floating-panels-ux-lesson/)).
   That argues against *floating* panels, not against *tinted* ones. Recto's panels stay docked
   and only their fill turns translucent.
4. **No glass on glass, no seams.** Both vendors warn against stacked or adjacent blurred panes.

**Products (established knowledge unless linked).** Arc's sidebar and Raycast's window are
macOS vibrancy over the desktop, and Arc's web content sits in an opaque inset card. Apple's web
navigation uses `backdrop-filter: saturate(180%) blur(20px)` over an 80 % light tint
([ac-globalnav.built.css](https://www.apple.com/ac/globalnav/3/en_US/styles/ac-globalnav.built.css),
via search abstract). Linear, Notion, tldraw and Excalidraw keep panels opaque or near-opaque.
The products people call "clean" use glass in one or two places and keep the content opaque.

---

## 2. Web mechanics and costs

| Topic | Fact | Consequence for Recto |
|---|---|---|
| Support | `backdrop-filter`: Chrome 76, Firefox 103 (unknown GPU vendors only from 123), Safari 18 unprefixed, `-webkit-` since 9 — [BCD](https://github.com/mdn/browser-compat-data/blob/main/css/properties/backdrop-filter.json) | Keep the `@supports … or (-webkit-backdrop-filter…)` gate and the prefixed declaration already in `global.css` |
| `prefers-reduced-transparency` | Chrome 118; Firefox 113 **behind a pref**; **Safari: not supported** ([WebKit bug 175497](https://webkit.org/b/175497)) — [BCD](https://github.com/mdn/browser-compat-data/blob/main/css/at-rules/media.json) | Mac and iPad users who turned on Reduce Transparency still get glass. An in-app setting is required. |
| `prefers-contrast` | Chrome 96, Firefox 101, Safari 14.1 (same source) | The existing `more` fallback works everywhere |
| Cost | Cost grows with the filtered area and blur radius, and the backdrop is filtered again on every frame where anything behind it changes, so scrolling content is the expensive case ([shadcn-ui#327](https://github.com/shadcn-ui/ui/issues/327); [Eminence#30](https://github.com/Ridhesh927/Eminence/issues/30)) | Scrolling a canvas of page bitmaps under full-height panels is the most expensive case Recto could create |
| GPU memory | In one Electron app, backdrop-filter made Chromium build render surfaces and give up macOS CALayer overlays: 585 MB instead of 176 MB of GPU memory with a text field focused. The app kept blur only on menus ("they open briefly") — [hercule#301](https://github.com/theagenticage/hercule/issues/301) | Always-visible glass has to earn its memory. The persistent tier gets geometry gating (§4.2). |
| Backdrop root | An ancestor with `opacity < 1`, `filter`, `mask` or its own `backdrop-filter` becomes the child's backdrop root, so a nested glass surface blurs only its parent's pixels — [Chromium 40720431](https://issues.chromium.org/issues/40720431), [havn.blog](https://havn.blog/2024/03/14/chromium-and-nested.html) | Menus and popovers opened from a glass panel must be portalled to the body. Never fade a glass surface's ancestor (`global.css` already notes this for popups). |
| Blur and saturate ranges | In practice, 12–40 px blur with saturate 120–180 % (Apple web 20 px and 180 %; Recto's bar 28 px and 1.8) | Larger radii hide page text better, which is what panels need. Saturate restores the chroma that averaging takes away. |

---

## 3. Contrast over unknown backdrops

Recto's glass composites as `result = a·tint + (1 − a)·b·backdrop` per channel, where `a` is
the tint alpha and `b` the `brightness()` factor. `saturate()` keeps Rec. 709 luma (apart from
clipping), and the blur only averages. So with a light text colour, the worst-case backdrop is
the brightest one: a white page. The backdrop term can never exceed `b·255`. That cap is what
lets Recto guarantee AA without sampling:

- **Adaptive tint (rejected for v1).** Pages cannot read pixels from behind an element. Recto
  could estimate from geometry ("is a page under the bar?") and flip between light and dark
  glass, as Apple does for small toolbars. Every flip mid-scroll is a visible jump, though, and
  the luminance cap already guarantees AA. Geometry is used only to turn blur off (§4.2), where
  the result is identical by construction.
- **Wells.** Where text has to be dense or editable, put it on an opaque well inside the glass
  (`--surface-2` with the control border). Apple's equivalent is the thicker material "for text
  and other elements with fine features".
- **Text mapping.** On every tier, secondary and tertiary text map to `--glass-text-secondary`,
  danger to `--glass-danger`, and the accent is never text. This is today's `.glass` rule,
  applied to the new tiers as well.

---

## 4. Recipe for Recto

### 4.1 Three tiers

| Tier | Surfaces | Tint (`--glass-*`) | Filter | Over the canvas | Over a white page |
|---|---|---|---|---|---|
| **1 Floating chrome** (unchanged) | Tool bar and options tier, contextual bars, crop banner, palette, view switch, page-anchored popovers | `rgb(48 51 58 / 0.66)` | `blur(28px) saturate(1.8) brightness(0.45)` | `#212328` (1.27:1 against the canvas) | `#47494d` |
| **2 Docked frame** (new) | Title bar, navigator rail and panel, inspector, status bar | `rgb(29 31 37 / 0.80)` | `blur(40px) saturate(1.4) brightness(0.6)` | `#181a1f`, **identical to `--surface-1`** | `#36373c` |
| **3 Menus and popovers** (new) | Every menu, the pen preset editor, privacy and link popovers | `rgb(40 43 50 / 0.80)` | `blur(32px) saturate(1.6) brightness(0.5)` | `#212329` (same family as tier 1) | `#393c42` |

Worst case (white page) for each text token, in ratios against the composite:

| Token | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| `--text-primary #e6e7ea` | 7.29 | 9.60 | 8.94 |
| `--glass-text-secondary #bcc0c6` | 4.94 | 6.50 | 6.05 |
| `--text-secondary #9a9ea6` (unmapped, for reference) | 3.36 ✗ | 4.42 ✗ | 4.12 ✗ |
| `--glass-danger #ffa0a0` | 4.63 | 6.10 | 5.68 |
| `--warning #f5c451` | 5.54 | 7.29 | 6.79 |
| `--accent` (non-text, needs 3:1) | 3.03 | 3.99 | 3.71 |

Tier 2 composites to exactly `--surface-1` over the canvas, so the ladder in DESIGN.md §3
(canvas to panel 1.14:1) does not change at rest. The panel lightens only when a page passes
underneath, which is the "what is behind shows through" the owner asked for. Tier 3 is denser
than tier 1 because menus are lists of text. Under the "bigger gets denser" rule, tier 2 should
not go below `a = 0.78`.

Proposed tokens, as additions next to the existing ones (not applied):

```css
--glass-frame: rgb(29 31 37 / 0.8);
--glass-frame-filter: blur(40px) saturate(1.4) brightness(0.6);
--glass-frame-solid: var(--surface-1);
--glass-menu: rgb(40 43 50 / 0.8);
--glass-menu-filter: blur(32px) saturate(1.6) brightness(0.5);
--glass-menu-solid: var(--surface-2);
```

### 4.2 Layout and cost rules

1. **The stage runs under the frame.** The navigator, inspector, title bar and status bar
   overlay a full-bleed stage. Fit and centring use the unobscured rectangle (the stage gets
   inline and block padding equal to the frame), so at "fit" nothing is hidden. Pages pass
   under the title bar on every scroll, and under the panels when zoomed or panned.
2. **Geometry-gated blur.** When no page rectangle lies within 2 × the blur radius (80 px) of a
   tier-2 surface, that surface sets `backdrop-filter: none` and paints `--glass-frame-solid`.
   The result is pixel-identical, because a blurred uniform canvas *is* `--surface-1`. Recto
   already has the page geometry, so this needs no measuring. In the common fit-width case it
   means zero blur cost on the panels.
3. **One filtered element per region.** Put the rail and its panel in one container with one
   `backdrop-filter`, and make the children transparent. Where two glass regions meet (title
   bar over panel), the existing hairline divider hides the seam that both vendors warn about.
4. **No glass on glass.** A tier-3 menu may overlap tier 1 or tier 2 because it is denser and
   has the ring. No glass surface may be a DOM descendant of another (portal to the body). No
   control inside a glass surface gets its own blur: segments and wells use alpha washes or
   opaque fills.
5. **Never animate the filter.** Popups fade with opacity on the surface itself, as today, and
   never change their blur or brightness.
6. **Budget.** With the inspector closed at 1440 × 900, the frame is about 30 % of the viewport.
   Accept the frame only if Read-view scrolling holds 60 fps on a 2020-class integrated GPU at
   DPR 2 with a page under the panels (Chrome's FPS meter and layer borders, plus `chrome://gpu`
   memory). Otherwise ship tier 2 as solid by default and offer glass as a setting.

### 4.3 What stays opaque

| Surface | Why |
|---|---|
| Text inputs, the Find field, rename fields, number fields | Typing needs a fixed background, and a caret blinking over glass keeps the compositor busy (hercule#301) |
| In-place editors on the page (text edit, free text) | DESIGN.md §3: "opaque page white with page ink" |
| Dialogs, side sheets and their scrim | Fluent's "smoke": modal surfaces should hide what is behind them |
| Tooltips and the toast | Small, short-lived, must read instantly; blur adds cost and no meaning |
| Home cards, thumbnails, the Arrange grid cells | They are content, and Apple says no glass in the content layer |
| Long dense lists inside tier 2 (Review rows, outline) | Stay on the tier-2 fill (`a = 0.80`). Do not add a lighter "clear" variant. If a list still reads as busy over a page, give the list area a `--surface-1` well. |
| Code and monospace blocks (diagnostics) | On a `--surface-2` well |

### 4.4 Fallbacks

- **In-app setting** (Settings, palette "transparency"): *System* (default), *Reduced*, *Off*.
  *Reduced* sets the three tiers to their `-solid` tokens with `filter: none` and keeps the ring
  and shadow, which is exactly today's `prefers-reduced-transparency` block. Implement it as a
  `data-transparency` attribute on `:root` that the media-query block also matches.
- `prefers-contrast: more` and forced colours: unchanged (solid, strong border, no elevation),
  extended to the new tiers.
- Without `backdrop-filter` support: every tier falls back to its `-solid` token through the
  existing `@supports` gate.
- `tokens.test.ts`: assert each tier with the compositing model above against four backdrops
  (white, `--surface-0`, mid-grey `#808080`, black), for every text token mapped on glass, plus
  the accent's 3:1. White is the binding case today, but the other three guard future tint
  changes.

---

## 5. Mode models in other apps

| App | Explicit Read/Edit? | Where | Text editing versus pen | Library versus document |
|---|---|---|---|---|
| GoodNotes 6 | Yes: Read Only Mode | Pencil icon in the nav bar. In Read Only the nav bar turns white and the writing toolbar hides; in edit it is blue. Links, comments and long-press highlight still work — [GoodNotes](https://support.goodnotes.com/hc/en-us/articles/7353757120655-Read-Only-Mode) (abstract) | Tools only; pen writes with the armed tool | Library grid → notebook |
| Notability | Yes, per note, in the note menu ("wrench… select read-only" — [Notability, 2013](https://x.com/NotabilityApp/status/316991189624700929)); one toolbar for everything else | Note options | Tool-based; Apple Pencil writes, finger scrolls | Library sidebar → note |
| Apple Notes, Freeform, Preview Markup | Markup is shown explicitly (pen-tip button, Shift+Cmd+A in Preview); "Only Draw with Apple Pencil" makes fingers scroll — [OSXDaily](https://osxdaily.com/2022/03/06/cant-draw-with-finger-ipad-fix/) | Toolbar button | Explicit tool palette | Folder list → note |
| Pages, Keynote (iPad) | Pencil draws by default; a "Select and Scroll" setting, togglable by Pencil double-tap — [Apple](https://support.apple.com/guide/pages-ipad/use-apple-pencil-with-pages-tan36493d985/ipados) | Settings | Pen draws or selects by setting | Document browser |
| OneNote | Draw tab in the ribbon; touch drawing is a toggle — [Microsoft 365 Insider](https://insider.microsoft365.com/et-ee/blog/draw-tab-and-inking-refresh-in-onenote-on-windows) | Ribbon tab | Typing is the default; ink only with a Draw tool | Notebook and section panes |
| Acrobat (2023 UI) | No lock. View plus "All tools"; **Edit PDF** is an explicit mode with dotted paragraph boxes, left by picking the selection tool — [NC Bar](https://www.ncbar.org/2023/09/19/adobe-acrobat-has-a-new-interface/), [Adobe](https://helpx.adobe.com/acrobat/using/edit-text-pdfs1.html) | Left tool rail | Page text is editable only in Edit PDF | Acrobat Home → document tabs |
| PDF Expert | Reading mode hides the toolbar; **Annotate** and **Edit** are buttons in the centre of the toolbar — [Readdle](https://support.readdle.com/pdfexpert/en_US/annotate-pdfs), search abstract | Toolbar centre | Page text only in Edit | File browser → document tabs |
| Xodo | A mode drop-down (View, Annotate, Draw, Fill and Sign…) at top left — [Xodo](https://xodo.com/blog/how-to-annotate-pdf) | Toolbar | Tools per mode | File list |
| Drawboard PDF | "Touch to Annotate" toggle: off means fingers scroll, zoom and select — [Drawboard](https://support.drawboard.com/hc/en-us/articles/4406251851791--Windows-Touch-to-Annotate) | Bottom bar | Pen draws | Projects |
| Word | **Editing / Reviewing / Viewing** drop-down at top right next to Share; Read Mode is a separate view — [Microsoft](https://support.microsoft.com/en-us/office/document-modes-in-word-263564df-4a7d-4526-9bbd-1186dc1b2915) (abstract) | Title-bar area, right | Typing everywhere in Editing | Backstage (File) |
| Google Docs | **Editing / Suggesting / Viewing** at top right — [SupportYourTech](https://www.supportyourtech.com/google/docs/switch-between-viewing-modes-in-google-docs-a-step-by-step-guide/) | Top right | — | Docs home |
| Figma | Design / Dev Mode toggle (Shift+D); Hand tool H, Space for a temporary hand — [Figma](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode) | Toolbar toggle | Text tool; double-click enters text | File browser |
| Procreate, Concepts | Pen-first; finger painting is an opt-in setting; two-finger tap undoes — [Procreate](https://help.procreate.com/procreate/handbook/actions/actions-preferences) | Preferences | Pen paints, fingers gesture | Gallery |

**What the survey shows.**

1. **An explicit mode appears where accidental marks are expensive.** That covers note apps
   with a pen (GoodNotes, Notability) and shared documents (Word, Docs). The switch lives in the
   top bar, close to the document title, and states its current value in words (Docs, Word) or
   with a tool icon (GoodNotes).
2. **Page text editing is always a separate, explicit tool or mode** (Acrobat Edit PDF, PDF
   Expert Edit). No PDF editor turns a plain click on page text into editing.
3. **The pen is disambiguated by input type rather than by gesture.** Pen draws, finger scrolls
   (Apple's setting, Drawboard, Procreate). Double-tap and long-press are kept for secondary
   actions such as selecting a word or a context menu.
4. **The library is a place, not a mode.** GoodNotes, Notability, Acrobat Home and Word's
   Backstage all leave the document entirely.
5. **Colour as a mode signal is rare and costly.** GoodNotes' blue edit bar is the only case,
   and it spends a whole bar's colour on state.

---

## 6. A mode model for Recto

### 6.1 Structure

- **Home** stays a view (key `0`, the app glyph). It is the list of open files and has no mode.
  The segmented control hides on Home.
- **A document is shown in Read, Edit or Arrange.** All three share selection. Read and Edit
  share the canvas and the scroll position, so switching between them never moves the page.
  Compare stays a view that appears only while a comparison is open.
- **Read (locked).** Scroll, zoom, find, select and copy text, follow links, open notes and
  comments read-only, and see form values. No tool can be armed, the floating bar collapses to a
  single **Edit** button, and nothing on the page changes.
- **Edit (tools).** Today's six-group bar, with the policy in §6.2.
- **Arrange.** The light table, unchanged. Choosing it is an explicit intent, so page moves are
  allowed there in either mode, and undo remains the safety net (DESIGN.md §4.4).
- **Default.** Opening a file shows Read. The last mode is remembered per document for the
  session only. A new blank document, or Fill & sign chosen from the palette, opens in Edit.

### 6.2 Edit-mode interaction policy

General rules: only the armed tool creates; creating does not select (DESIGN.md §4.3); page
text changes only through Edit text; double-click never creates; touch never shows hover
affordances.

| Tool class | Click on page text | Click on an annotation | Click on empty paper | Double-click | Drag | Pen | Long press (touch) |
|---|---|---|---|---|---|---|---|
| **Read mode** (for contrast) | Place caret for selection; nothing editable | Note or comment opens read-only; link follows | Nothing | Select word | Select text | Same as mouse; never marks | Select word, show Copy and **Mark up…** (goes to Edit, keeps the selection) |
| **Select** (V, the idle tool in Edit) | Starts a text selection; the contextual bar offers highlight, underline and comment | Selects it (handles, contextual bar) | Clears the selection | Word on text; on a text box or note, edits *its* text; never edits page text | From text: selects text. From an annotation: moves it. From paper: marquee | Like the mouse, unless "Pen draws in Edit" is on (§6.3) | Select word; context menu on an annotation |
| **Text markup** (H, U, S, squiggly) | Click selects the word and marks it | Passes through to the text under it | Nothing | Marks the word | Marks the dragged text run | Same as drag | Same as drag after a 300 ms hold |
| **Text box, note** (T, N) | Places a box or note at the click (on text too: it is an overlay) | Selects that annotation instead of creating | Places a box or note | — | Text box: sets its width | Same | Same |
| **Edit text** (E) | Hover shows the run outline (mouse or pen hover only); a click opens the in-place editor | Ignored (annotations dim) | Nothing; no new text from a click on paper | Selects a word in the editor | Selects inside the editor | Clicks like a mouse; **never** draws | Opens the editor |
| **Pen, marker, highlighter** (P) | Draws | Draws over it | Draws | — | Draws | Draws (pressure) | A finger never draws once a pen has been seen (DESIGN.md §4.1) |
| **Eraser** (Shift+E), pen eraser end | Nothing | Erases the path under it | Nothing | — | Erases along the path | The eraser end (`buttons & 32`) is a temporary eraser in any Edit tool | — |
| **Lasso** (Q), pen barrel button | — | — | — | — | Lasso | The barrel button (button 2) is a temporary lasso | — |
| **Shapes** (R, O, L, A, G) | Starts a shape | Starts a shape on top | Starts a shape | — | Sizes it (Shift constrains) | Same | Same |
| **Forms, Fill & sign** | Field: focus and type; elsewhere nothing | Selects a created field | Signature or stamp: place, then return to the previous tool | — | Moves a placed signature | Same | Same |
| **Redact** (X) | Marks the text run | Selects a mark | Area mark (drag) | — | Marks an area | Same | Same |

**Read mode and forms.** A click on a field shows its focus ring and an anchored line, "Switch to
Edit to fill", with an **Edit** button. That is one explicit step, never an implicit switch.

### 6.3 Keyboard, pen and touch

- **Keys.** `0` Home, `1` Read, `2` Edit, `3` Arrange, `4` Compare. This is a one-time shift of
  today's `2`/`3`, chosen so the keys match the control's order. A tool shortcut pressed in Read
  switches to Edit and arms the tool. It is deliberate, visible (the control flips, the bar
  opens) and changes nothing on the page until the first stroke. Esc never leaves Edit: it
  clears the tool and selection, and then returns the bar to its group row, as today.
- **Temporary hand.** Holding Space pans in both modes (Figma's convention; `H` is taken by
  Highlight).
- **Pen in Edit.** A setting, "Pen draws in Edit", turns on automatically the first time a pen
  is seen (DESIGN.md §4.1 already tracks this). With it on, a pen touch while Select is armed
  draws with the last preset, as in GoodNotes and Notability. With it off, the pen behaves like
  a mouse (Pages' "Select and Scroll"). The Edit-text tool always takes the pen as a pointer.
- **Touch.** Once a pen has been seen, one finger pans and two zoom. A long press is the only
  touch selection gesture, and touch never gets hover outlines.

### 6.4 How the mode is surfaced

| Option | Verdict | Reason |
|---|---|---|
| **Segmented control "Read · Edit · Arrange"** where the view switch sits today (top centre of the stage, tier-1 glass) | **Adopt** | One control for "what am I doing with this document", in words, like Docs and Word. It reuses the view-switch "on" look (`--surface-3` with an inset hairline), so nothing new enters the system. |
| Lock glyph inside the Read segment | **Adopt** | States "locked" without colour (DESIGN.md §5: nothing by colour alone) |
| The floating bar collapses to one **Edit** button in Read | **Adopt** | Puts the way into Edit near the hand on tablets. The bar's shape becomes the second signal. |
| Tint the bar or title bar by mode (GoodNotes) | **Reject** | DESIGN.md §3: "Chrome is never tinted; the accent stays its only colour" |
| Moving the control into the title bar | **Reject for now** | The tabs and ⌘K already fill it, and the control would drift away from the stage it describes |

Naming: "Read" now names the locked mode rather than the continuous-pages view. The Read *tool
group* in the bar should become **Select** (it holds Select today), so "Read" means one thing.

---

## 7. Palettes in other apps

| Source | Default inks (hex) | OKLCH lightness range | Contrast on white |
|---|---|---|---|
| Recto today (`pen/presets.ts`) | `#1F1F1F #1E5BD8 #E53935 #FFD400 #43A047 #FB8C00 #8E24AA #D81B60` | 0.49–0.88 (chromatic) | 1.43 (yellow) to 7.04 |
| Excalidraw stroke defaults ([colors.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/colors.ts)) | `#1e1e1e #e03131 #2f9e44 #1971c2 #f08c00` (the darkest of the five shades per hue in its picker) | 0.54–0.73 | 2.48–5.02 |
| tldraw 5.5.2 light ([defaultThemes.ts](https://github.com/tldraw/tldraw/blob/main/packages/editor/src/lib/editor/managers/ThemeManager/defaultThemes.ts)) | `#1d1d1d #4465e9 #e03131 #099268 #ae3ec9 #e16919 #f1ac4b` … | 0.56–0.79 | 1.95–4.90 |
| tldraw highlighters | sRGB `#fddd00 #10acff #00ffc8 #ff636e`, with Display-P3 variants | — | Drawn twice: an underlay at 0.82 below the shapes and an overlay at 0.35 above ([HighlightShapeUtil.tsx](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/shapes/highlight/HighlightShapeUtil.tsx)) |
| FigJam connectors and markers ([figjam-colors.md](https://github.com/figma/mcp-server-guide/blob/main/skills/figma-use-figjam/references/figjam-colors.md)) | `#1E1E1E #3DADFF #874FFF #F849C1 #FF7556 #FF9E42 #FFC943 #66D575` | 0.59–0.86 | 1.53–4.57 |
| Apple system colours (iOS 18 light; established values, [swiftuicolors](https://swiftuicolors.com/ios-colors)) | `#007AFF #FF3B30 #34C759 #FFCC00 #FF9500 #AF52DE #FF2D55` | 0.60–0.87 | 1.51–4.13 |
| GoodNotes, Notability, OneNote, Whiteboard | Not published (OneNote has 16 pen colours, Whiteboard 15). GoodNotes shows three presets per tool and 15 quick colours — [GoodNotes](https://support.goodnotes.com/hc/en-us/articles/7353743265039-Adding-colors-to-Writing-tools-pen-pencil-highlighter-tape-draw-shape) (abstract) | — | — |

Everyone uses a near-black (`#1d1d1d`–`#1f1f1f`) rather than `#000000`. That keeps handwriting
distinct from the page's printed black and less harsh at 1–2 pt. Whiteboard apps tolerate light
inks because their strokes are thick shapes. A PDF pen at 1.5 pt is handwriting, so it needs
text-grade contrast. All of these palettes assume white paper. The dark canvas around Recto's
page makes light inks *look* brighter in the chrome swatches, which is a reason to judge inks
only on white.

**What makes a palette look clean.** (a) Each colour sits near the gamut edge for its lightness
(high relative chroma; muddy colours are ones pulled towards grey). (b) Lightness is consistent
within a role. (c) Hues are spaced so no two read as "the same, slightly off". (d) Highlighters
use Multiply, so text under them stays fully black (research 12 §7 already plans `/BM
/Multiply` in the appearance stream and `mix-blend-mode: multiply` in the preview).

---

## 8. Proposed ink and highlighter palettes

Writing inks are AA for text on white (≥ 4.5:1). Accent inks meet 3:1 (WCAG 1.4.11 for
graphics) and sit near their hue's cusp, so they do not turn brown. "% max C" is chroma as a
share of the sRGB maximum at that lightness and hue.

| # | Name | OKLCH | Hex | On white | % max C | Replaces |
|---|---|---|---|---|---|---|
| 1 | Black | `oklch(0.218 0 0)` | `#1a1a1a` | 17.4:1 | — | `#1F1F1F` |
| 2 | Blue | `oklch(0.540 0.225 262)` | `#1760ee` | 5.32:1 | 90 | `#1E5BD8` (83 %) |
| 3 | Red | `oklch(0.570 0.220 27)` | `#db1c22` | 5.00:1 | 95 | `#E53935` (84 %, 4.23:1) |
| 4 | Green | `oklch(0.540 0.148 150)` | `#02853c` | 4.75:1 | 99 | `#43A047` (76 %, 3.30:1) |
| 5 | Violet | `oklch(0.520 0.225 300)` | `#8036d3` | 6.20:1 | 81 | `#8E24AA` |
| 6 | Orange | `oklch(0.660 0.175 48)` | `#e46910` | 3.32:1 | 97 | `#FB8C00` (2.37:1) |
| 7 | Pink | `oklch(0.610 0.225 355)` | `#e02c8a` | 4.29:1 | 90 | `#D81B60` |
| 8 | Sky | `oklch(0.620 0.130 235)` | `#0891c9` | 3.56:1 | 99 | `#FFD400` (yellow moves to the highlighters) |

Highlighters use Multiply at **40 %** (the preset already uses 40 %; the useful range is 35–50
%). The highlighted lightness band was aligned to 0.90–0.96, so the four read as one set:

| Name | Base OKLCH | Base hex | Result on white | Black ink on it | Red ink on it |
|---|---|---|---|---|---|
| Yellow | `oklch(0.91 0.184 100)` | `#fee320` | `#fff4a6` | 15.5:1 | 4.46:1 |
| Green | `oklch(0.87 0.210 145)` | `#6af776` | `#c3fcc8` | 15.0:1 | 4.30:1 |
| Pink | `oklch(0.76 0.164 352)` | `#fe81bc` | `#ffcde4` | 12.5:1 | 3.60:1 |
| Blue | `oklch(0.81 0.114 232)` | `#6dcefe` | `#c5ebff` | 13.8:1 | 3.98:1 |

For comparison, today's `#FFD400` at 40 % gives `#ffee99`, and the text-highlight default
`#FFEB3B` gives `#fff7b1`: pale and slightly green-yellow.

**Rules.** The preset editor shows the eight inks for pens and the four highlighters for a
preset below full opacity. All values stay in sRGB, because the PDF stores DeviceRGB.
Display-P3 variants like tldraw's would make the screen disagree with the saved file. Stamps,
underline, strikeout and squiggly should take their colours from this palette (blue, red,
green) rather than the Material values in `annotation-store.ts` and `stamps.ts`.

---

## 9. The UI accent

`#7c8cff` is `oklch(0.681 0.169 275)`. The sRGB maximum chroma at that lightness and hue is
**0.170**, and Display-P3 only reaches 0.184. So the accent is already as saturated as that
lightness allows. It reads soft for two reasons. Blue-violet hues reach their chroma peak around
L 0.45, so at L 0.68 the only way to get there is to add white. And on a near-black field,
lightness contrast makes it look lighter still.

| Option | Hex / OKLCH | Label (`--surface-0`) | Armed fill against tier-1 glass on white | Cost |
|---|---|---|---|---|
| A. Keep | `#7c8cff` · 0.681 0.169 275 | 6.69:1 | 3.03:1 at brightness 0.45 | None |
| B. Slightly deeper | `#7584fe` · 0.661 0.179 275; hover `#8694ff`, pressed `#6976f3` | 6.15:1 (hover 7.30, pressed 5.20) | 3.01:1 **only at brightness 0.40** (white page blends to `#424449`) | The glass gets a little greyer over pages, close to the "slab" the M6 review rejected at 0.36 |
| C. Deeper still | `#6e7cfd` · 0.641 0.190 275 | 5.66:1 | Needs brightness 0.33 | Not acceptable, unless the armed fill gets a 1 px `--surface-0` ring, which satisfies WCAG 1.4.11 through the adjacent dark colour and frees the accent from the glass brightness |

Recommendation: keep A. If the owner still finds it washed out, A/B test B against A on the
tool bar over a white page and over the canvas, and rerun `tokens.test.ts`. Do not add a second
accent. The cleaner look should come from the inks (§8), which are content, while the chrome
stays neutral (DESIGN.md §3).

