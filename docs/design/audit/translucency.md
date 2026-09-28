# Translucency proposal (DESIGN.md §7, "surfaces should read as more translucent")

**Status:** proposal with a mock, for owner review, 2026-09-28. No source file is changed. The
mock is the CSS in [`mock-glass.css`](mock-glass.css), injected into the production build of
`9b46d12` with Playwright `page.addStyleTag`. The before and after pictures are the same scenes
captured twice.

## 1. What changes, in one paragraph

Floating surfaces over the document become real frosted glass. The tint drops from 86% to 50%
opacity. The backdrop is blurred more (24px instead of 16px), its colour is boosted
(`saturate(1.8)`) and it is darkened (`brightness(0.4)`), so the page shows through as blurred
colour and light while text on the glass keeps WCAG AA even over a pure white page. Over the
dark canvas the glass looks the same as today. Over a white page it becomes a lighter,
see-through grey (#3f4043 instead of today's flat #323336). Over figures and colour it picks up
their hue ([mock-03-annotation-bar](mock-03-annotation-bar.png),
[mock-08-image-bar](mock-08-image-bar.png)). Menus and popovers, which are opaque today, join the
glass family. Docked panels, dialogs and tooltips stay opaque.

## 2. Which surfaces

| Surface | Today | Proposed | Why |
| --- | --- | --- | --- |
| Floating tool bar (`FloatingToolbar .toolbar`) | glass 0.86 | **frosted** | §2: "the one translucent surface" |
| Annotation contextual bar (`AnnotationLayer .bar`) | glass 0.86 | **frosted** | §7 |
| Image bar (`ImageObjects .bar`) | glass 0.86 | **frosted** | same family as the annotation bar |
| Arrange contextual bar (`ArrangeView .contextBar`) | glass 0.86 | **frosted** | same family |
| Crop hint banner (`Crop .banner`) | glass without `saturate` or the `-webkit-` prefix | **frosted** (shared rule) | fixes the Safari fallback gap (effects A6) |
| Command palette (`CommandPalette .popup`) | glass 0.86 on the scrim | **frosted** on the scrim | §2 lists it as floating chrome. On the scrim the change is small ([mock-05-palette](mock-05-palette.png)). |
| Menus: tool menus, zoom, document, context, tab (`Menu .popup`) | opaque surface-3 + border-strong | **frosted** | §7 "menus" |
| Popovers: privacy, link (`Popover .popup`) | opaque surface-3 | **frosted** | §7 "popovers" |
| Text-edit header (`TextEdit .panel`), note popup (`AnnotationLayer .notePopup`), form notice (`FormLayer .notice`) | opaque surface-3 | **frosted** (decision D3) | they are popovers anchored to the page |
| Created-field properties popover (`CreatedFields .popup`) | opaque surface-3 | opaque | a scrolling form with many inputs: a reading and writing surface |
| Tooltips (`Tooltip .popup`) | opaque surface-3 | **opaque** (decision D2) | tiny text, shown for under a second; frosting adds nothing but risk |
| Update toast (`UpdateToast .toast`) | opaque surface-3 | opaque | it sits over the docked status area, not the document |
| Dialogs (`ShortcutOverlay .popup` and everything layered on it) | opaque surface-1 on the scrim | opaque | reading surfaces (§3, research §5) |
| Tab bar, left rail, right panel, status bar | opaque surface-1 | opaque | §7: "Panels docked to the frame stay opaque" |
| Inline error chips (`InlineTitleEditor .error`, `Outline .renameError`), drop labels | opaque surface-3 | opaque | danger text on a tiny chip |

## 3. Token changes (`apps/web/src/styles/tokens.css`)

```css
:root,
[data-theme='dark'] {
  /* Floating chrome over the document. The backdrop is blurred, colour-boosted and darkened
     before the tint is laid on it, so the glass shows the page's colour and light but its
     worst case (a white page) stays at #3f4043: every glass text colour is AA there. */
  --glass: rgb(24 26 31 / 0.5);                                 /* was rgb(16 18 21 / 0.86) */
  --glass-filter: blur(24px) saturate(1.8) brightness(0.4);     /* replaces --glass-blur: 16px + saturate(1.2) */
  --glass-solid: #16181c;                                       /* unchanged: the opaque fallback */
  --border-glass: rgb(255 255 255 / 0.1);                       /* was 0.12; also the proposed single border alpha */

  /* Text on glass: two steps. Tertiary maps to secondary, because #858a92 cannot reach 4.5:1
     on any glass that visibly shows a white page. */
  --glass-text-secondary: #b4b8bf;
  --glass-text-disabled: #6f737b;   /* disabled icons stay visible (2.2:1) over a white page */
  --glass-danger: #ff8a8a;          /* "Delete" in the image bar: #ff6b6b would be 3.74:1 */
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  :root {
    --glass: var(--glass-solid);
    --glass-filter: none;
  }
}

@media (forced-colors: active) {
  :root {
    --glass: Canvas;
    --glass-filter: none;
    --border-glass: CanvasText;
  }
}
```

`--glass-blur` goes away; there is exactly one filter token.

## 4. One shared glass rule

Today each of the six glass modules repeats its own `@supports` block, and one of them (the
crop banner) is incomplete. Proposed: `apps/web/src/ui/Glass.module.css`, which each floating
surface composes (`composes: glass from '../ui/Glass.module.css';`):

```css
.glass {
  /* Opaque first: this is what browsers without backdrop-filter render. */
  border: 1px solid var(--border-glass);
  background: var(--glass-solid);

  /* Text colours on glass (both AA over a white page; see §6). Scoped custom properties,
     so every descendant that uses the ladder picks them up without per-component changes. */
  --text-secondary: var(--glass-text-secondary);
  --text-tertiary: var(--glass-text-secondary);
  --text-disabled: var(--glass-text-disabled);
  --danger: var(--glass-danger);
}

@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
  .glass {
    background: var(--glass);
    -webkit-backdrop-filter: var(--glass-filter);
    backdrop-filter: var(--glass-filter);
  }
}

/* The opaque fallbacks must also restore the normal text ladder: without a blur the
   darkening is gone, and the lighter glass colours are simply lighter text (still AA). */
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .glass {
    background: var(--glass-solid);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}
```

In the `prefers-contrast: more` branch, tokens.css already raises `--border-glass` to 0.36 and
the text ladder to lighter values; that stays as it is.

**Border over the blur:** one 1px hairline at the single border alpha (white 0.10). Over a white
page the glass edge is already defined by the tint (#3f4043 against #fff). Over the dark canvas
the hairline carries the edge (#262729 against #0e0f12). There is no inner highlight and no
shadow (§1).

**Radius:** bars, palette and panel-like surfaces keep `--radius-3` (10). Menus, popovers and the
text-edit header use `--radius-2` (6) (see the radius scale in effects.md).

## 5. The mock

Scenes use a scratch PDF with a white text block, a colour band, a black band and a blue disc
(`backdrop.pdf`, generated for the audit and not committed), plus the repository fixtures
`simple-text`, `images`, `outline-named-dests`, `forms-a` and `text-edit-fonts`.

| Scene | Before / after (crops, 2×) | After (full frame) |
| --- | --- | --- |
| Floating tool bar over page text and a figure | [mock-02-read-toolbar](mock-02-read-toolbar.png) | [mock-after-02-read-toolbar](mock-after-02-read-toolbar.png) |
| Annotation bar over a colour band | [mock-03-annotation-bar](mock-03-annotation-bar.png) | [mock-after-03-read-annotation-bar](mock-after-03-read-annotation-bar.png) |
| Shapes menu over dark page content | [mock-04-menu-shapes](mock-04-menu-shapes.png) | [mock-after-04-menu-shapes-over-page](mock-after-04-menu-shapes-over-page.png) |
| Zoom menu over the docked panel | [mock-04-menu-zoom](mock-04-menu-zoom.png) | |
| Command palette on its scrim | [mock-05-palette](mock-05-palette.png) | [mock-after-05-palette](mock-after-05-palette.png) |
| Privacy popover over the rail and the page | [mock-07-popover-privacy](mock-07-popover-privacy.png) | [mock-after-07-popover-privacy](mock-after-07-popover-privacy.png) |
| Image bar | [mock-08-image-bar](mock-08-image-bar.png) | [mock-after-08-image-bar](mock-after-08-image-bar.png) |
| Arrange contextual bar / context menu | [mock-10-arrange-contextbar](mock-10-arrange-contextbar.png), [mock-10-arrange-context-menu](mock-10-arrange-context-menu.png) | [mock-after-10-arrange-context-menu](mock-after-10-arrange-context-menu.png) |
| Text-edit header over the page | [mock-12-text-edit-open](mock-12-text-edit-open.png) | [mock-after-12-text-edit-open](mock-after-12-text-edit-open.png) |
| Contrast swatches (current vs proposed glass over uniform backdrops) | [glass-contrast-swatches](glass-contrast-swatches.png) | |

**Honest reading of the mock.**

- The change is clearest where the glass crosses **light or coloured** content: the annotation
  bar over the colour band, the image bar over the photo, the popover straddling the white page,
  and the text-edit header over the page.
- Over **dark** content (the Shapes menu over the black band) and on the **palette** (which sits
  on the scrim), before and after look much alike. That is expected: a dark tint over dark content
  stays dark.
- The toolbar over plain white text is only slightly lighter. More transparency over white is
  where AA runs out (next section).

**Can it go further?** Not without giving something up. The white-page worst case sets the
limit, and the binding constraint is the **focus ring**: the accent (#7c8cff) needs 3:1 against
the glass (WCAG 1.4.11), and it is at 3.48:1 now. The next constraint is glass-secondary text at
4.5:1 (5.21:1 now). A stronger variant (tint 0.4, brightness 0.5) takes the white-page glass to
#56575a, which puts the ring at 2.43:1 and glass-secondary text at 3.64:1; both fail. The proposal sits near the maximum
translucency that AA allows for a dark UI over arbitrary pages.

**Rendering note.** Headless Chromium's default software compositor draws `backdrop-filter`
incorrectly: blur only in one direction, with sharp "ghost" text near surface edges. The first
round of mocks showed this and was thrown away. All pictures here were captured with
`--use-gl=angle --use-angle=swiftshader`, which blurs correctly (checked against controlled test
pages). Before landing, confirm the look in desktop Chrome, Safari and Firefox. The quickest way:
open the app, paste `mock-glass.css` into DevTools (its selectors match this build's CSS-module
hashes and may need updating on a newer build).

## 6. Contrast (WCAG 2.2 AA, text 4.5:1, non-text 3:1)

**Method.** Worst cases are **uniform** backdrops, because blur cannot lower the peak of a
uniform area: a large white area stays white. The model is `glass = a·tint + (1−a)·clamp(k·backdrop)`,
applied per sRGB channel (Chromium applies `brightness()` in sRGB; `saturate()` does nothing on
greys). Each value was **also measured**: the proposed CSS was rendered over 200×200 swatches in
Chromium and the centre pixel sampled. Model and sample agree within 3 levels per channel. The
palette row includes its `--scrim` (rgb(5 6 8 / 0.56)). Ratios below come from the sampled
colour; bold means under 4.5:1.

| Glass | Backdrop | Glass colour (model / sampled) | primary | secondary | tertiary | glass-secondary | accent | danger | glass-danger | warning |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| current | white page #ffffff | #313336 / #323336 | 10.22 | 4.70 | **3.64** | 6.35 | **4.24** | 4.55 | 5.57 | 7.76 |
| current | yellow figure #f3d933 | #302e19 / #312e14 | 11.09 | 5.10 | **3.95** | 6.89 | 4.60 | 4.94 | 6.04 | 8.42 |
| current | black page #000000 | #0e0f12 / #0e0f12 | 15.50 | 7.13 | 5.52 | 9.63 | 6.44 | 6.91 | 8.45 | 11.77 |
| current | app canvas #0a0b0d | #0f1114 / #0f1013 | 15.39 | 7.08 | 5.48 | 9.56 | 6.39 | 6.86 | 8.38 | 11.68 |
| **proposed** | white page #ffffff | #3f4043 / #3f4043 | **8.38** | (3.86, not used) | (2.99, not used) | **5.21** | **3.48** (non-text ≥ 3 ✓) | (3.74, not used) | **4.57** | **6.37** |
| proposed | yellow figure #f3d933 | #3d381a / #3f3910 | 9.41 | (4.33) | (3.35) | 5.85 | 3.91 | (4.19) | 5.13 | 7.15 |
| proposed | mid grey #808080 | #262729 / #252629 | 12.24 | 5.63 | 4.36 | 7.60 | 5.08 | 5.45 | 6.67 | 9.29 |
| proposed | saturated blue #2a6fd6 | #14233a / #0c2443 | 12.59 | 5.79 | 4.48 | 7.82 | 5.23 | 5.61 | 6.86 | 9.56 |
| proposed | black page #000000 | #0c0d10 / #0c0d10 | 15.72 | 7.23 | 5.60 | 9.76 | 6.53 | 7.00 | 8.56 | 11.93 |
| proposed | app canvas #0a0b0d | #0e0f12 / #0e0f13 | 15.49 | 7.13 | 5.52 | 9.62 | 6.43 | 6.90 | 8.44 | 11.76 |
| proposed + palette scrim | white page #ffffff | #232427 / #232427 | 12.55 | 5.78 | **4.47** | 7.80 | 5.21 | 5.59 | 6.84 | 9.53 |
| proposed + palette scrim | black page #000000 | #0d0e10 / #0c0d11 | 15.71 | 7.23 | 5.59 | 9.76 | 6.52 | 7.00 | 8.56 | 11.93 |
| opaque fallback (`--glass-solid`) | any | #16181c | 14.37 | 6.61 | 5.12 | 8.93 | 5.97 | 6.40 | 7.83 | 10.92 |

**Minimum on the proposed glass, for the colours actually used on it** (primary,
glass-secondary for secondary and tertiary, glass-danger, warning): **4.57:1** (glass-danger over
a white page). Text-primary is at least 8.38:1, glass-secondary at least 5.21:1 and warning at
least 6.37:1. The accent is used on glass only for the focus ring, the active-tool fill, slider
thumbs and the checked dot, all non-text: at least 3.48:1. Accent-coloured *text* must stay off
glass (it would be 3.48:1). Disabled icons (exempt from WCAG) go from 1.24:1 with #4a4e55 to
2.18:1 with `--glass-text-disabled` over a white page.

The **current** glass already fails for tertiary text (3.64:1) and would for accent text
(4.24:1) over a white page. The tokens.css comment says tertiary is not used on glass, and that
holds today; it will not hold once menus (hints, submenu arrows, keycaps) become glass, hence
the scoped remap in §4.

`glass-contrast-swatches.png` shows the same numbers rendered: real text on the current and
proposed glass over each backdrop.

## 7. Implementation notes and risks

1. **Put `backdrop-filter` on the surface itself**, not on a `::before` layer. Base UI fades
   popups by animating `opacity` on the popup. An ancestor with `opacity < 1` becomes the
   backdrop root for its descendants, so a pseudo-element's blur disappears for the whole fade
   (verified on a test page). The element's own backdrop-filter is unaffected by its own opacity.
2. **Safari** needs `-webkit-backdrop-filter` (the crop banner lacks it today) and an
   `@supports` test that includes the prefixed property.
3. **Many blurs at once:** at most about 3 at the same time (tool bar + contextual bar + a menu).
   24px blurs are cheap at these sizes. The palette (600×480) is the largest and is already
   blurred today.
4. **Scoped text remap** (§4): components that read `--text-secondary` or `--text-tertiary`
   inside a glass surface get the glass values automatically. Keycaps and inputs inside glass
   keep their own opaque fills, and lighter text on them only raises contrast.
5. **Tests:** the Playwright specs assert behaviour, not colour, so nothing should break. The
   design screenshots under `docs/design/screenshots/` will need re-capturing after the change.
6. **DESIGN.md §2** says the floating tool bar is "the one translucent surface"; §7 widens that to
   menus and popovers. Update §2 and §3 in the same change.
