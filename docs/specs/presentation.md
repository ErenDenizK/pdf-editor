# Spec: Presentation and public beta (M7)

**Status:** draft (2026-10-01) · **Milestone:** M7 (→ 1.0.0-beta.0) · **Owner:** project lead

M7 makes the project presentable and releases it: a README that shows the product working,
media produced by a script rather than by hand, a small about page beside the app, the
repository's metadata, the rename to Recto with the move to its own domain, and the first
public release. Every public sentence is a claim a reader can check. Source: the
presentation and naming studies of 2026-10-01.

## 0. Decisions this spec builds on

| Topic | Decision | Source |
|---|---|---|
| Name | Recto; descriptor "Recto PDF"; storage names unchanged | ADR-0015 |
| Address | own domain (`rectopdf.app` recommended), one step with the rename | ADR-0016 |
| App location | stays at the site root; no `/app/`; `/about/` is a sibling | ADR-0016 §4 |
| First release | `1.0.0-beta.0`, Changesets pre mode, GitHub pre-release | ADR-0017 |
| Media storage | built in CI, served from the site under `media/`, never committed | §2.6 |
| UI shown | the M6 layout; scenes are written after M6 freezes it | ROADMAP M6 |

## 1. README

Target about 180 lines. The first screen (about 900 px) answers what it is, why, and where
to try it. The README is the source text; the about page, release notes and a later
portfolio case study copy its sentences.

### 1.1 Structure, section by section

1. **Head** (centred): glyph (48 px), `<h1>Recto</h1>`, one bold thesis line ("A PDF
   editor that runs entirely in your browser. Nothing is uploaded."), one line listing the
   jobs (open many PDFs, arrange pages on one light table, annotate, fill, redact, edit
   text, recognise scans, compare, sign), a link row (Open the app · How it works · What it
   does not do · Roadmap), and three badges only: CI, latest release, licence.
2. **Hero still**: the light table with three demo documents, linked to the app. Dark only
   until the light theme ships; then a `<picture>` pair.
3. **Why it exists**: three short paragraphs, no bullets. Files stay on the device and you
   can check it; one workspace instead of a page of single-purpose tools; correctness first
   (exports are verified, redaction removes content).
4. **Four clips** (§6, clips 2–5): Move pages between documents · Redact, and the text is
   gone · Recognise a scan · Compare two versions. Each is a bold one-line claim, two
   sentences (the second states the limit) and a full-width GIF.
5. **More in the app**: a compact table (edit text, sign and check signatures, forms and
   annotations, Markdown export, batch recipes), one sentence per row, each linking to its
   clip on the about page.
6. **Check it yourself**: things to verify, not adjectives. The CSP line from
   `apps/web/index.html` (`connect-src 'self'`); the status bar's external-request count
   (`apps/web/src/privacy/external-requests.ts`, with its stated coverage limits); offline
   after one visit (`apps/web/e2e/offline.spec.ts`); OCR packs (about 22 MB) download from
   the same origin only when used; no telemetry, accounts or cookies; what is stored
   locally (PWA cache, kept OCR packs, recipes); the media run's request log (§2.3).
7. **How it works**: a Mermaid flowchart (UI thread → Comlink → PDFium, pdf-lib, qpdf,
   tesseract, signature and analysis workers → document model and history → export →
   verification → download). Links `docs/ARCHITECTURE.md`.
8. **What it does not do**: no Office conversion; no PDF/A claims; signatures are Intact,
   Changed after signing or Cannot check, never "valid", and no LTV; text edits one line at
   a time; Markdown reading order is a heuristic, no tables; OCR verified on Chromium only
   until the beta closes that gap; no collaboration. Links the ROADMAP's known behaviours.
9. **How it compares** (optional, dated): by category (hosted sites, self-hosted toolkits,
   browser viewers, Recto), never by brand; says where others win (conversion, server API,
   tool count); footnote with the date and `docs/research/02-market-and-ux.md`.
10. **Use it**: the URL; install as an app; self-host by unzipping a release's dist zip on
    any static host.
11. **Develop**, **Documents**: the existing command block and table, unchanged.
12. **Built on**: PDFium via EmbedPDF, @cantoo/pdf-lib, qpdf, tesseract.js, pkijs,
    pixelmatch, jsdiff, Inter, JetBrains Mono, Noto Serif, with licences; links `NOTICE`.
13. **Contributing · Security · Licence**: one line each.

Left out: emoji, star-history charts, contributor walls, social links, "PRs welcome", a
table of contents.

### 1.2 Copy guidelines (README, about page, release notes)

1. Say what it does in mechanism words: "removes the text, images and paths under each
   mark, then re-reads the exported file", not "secure redaction".
2. Every claim has evidence one click away: a test, a CI step, a source file, an ADR.
3. Pair a capability with its limit where a reader would otherwise assume too much.
4. Numbers carry their scope ("98% of words found on our test scans, Chromium"). No speed
   claim without a measurement and the machine it ran on.
5. Use the app's own nouns: light table, Arrange, Read, Intact, Changed after signing,
   recipe. A signature is never "valid", "verified" or "trusted".
6. Name other products only with a date and a source, and say where they are better.
7. State the status plainly: version, "Public beta", built and maintained by one person,
   not audited by a third party, Chromium, Firefox and WebKit in CI.
8. Sentence-case headings, short sentences, active voice, one idea per paragraph.

### 1.3 Banned words

powerful, blazing, lightning, seamless, effortless, simply, just, magic, best-in-class,
enterprise-grade, military-grade, secure (on its own), revolutionary, the only. No
exclamation marks, no emoji, no "we're excited". The link checker (§8) greps README,
`apps/web/about/` and the release-notes template for this list.

## 2. Media pipeline (`tools/media/`)

### 2.1 Principles

- **Scripted.** Every still and clip is a Playwright scene; a UI change is one command
  from fresh media. The design-review captures (`CAPTURE_SCREENSHOTS=1`, 1x, synthetic
  fixtures) stay separate.
- **The app's design rules.** No device frame, no fake browser chrome, no drop shadow.
  Each image is the viewport or a crop with a baked-in 10 px radius (`--radius-3`) and a
  1 px `rgb(255 255 255 / 0.10)` hairline on transparent corners, rendered by placing the
  PNG in a small HTML page and screenshotting it with `omitBackground: true`.
- **Deterministic.** Fixed clock (`page.clock.setFixedTime`), UTC, `en-US`, comment author
  "Demo", fixed fixture dates; Turkish variants via `?lang=tr`.

### 2.2 Demo fixtures

`tools/fixtures/demo-fixtures.ts` writes `test/fixtures/demo/` with the corpus's rules:
fixed dates, seeded PRNG, `--check` mode, provenance in `test/fixtures/README.md`. Fonts
are the bundled OFL fonts only (Inter, Noto Serif, JetBrains Mono); charts are vector
drawn; no third-party text or images. Every page carries the footer **"Demo document,
fictional data"**, so no clip can pass as a genuine record.

- `demo-report-v1.pdf`, `demo-report-v2.pdf` (10 pages; clips 1, 2, 5, 6, 8): a fictional
  club's annual report with headings, two charts, a table, an outline, page labels i–ii and
  1–8, internal links. v2 changes one figure, one paragraph and one chart bar.
- `demo-agreement.pdf` (4 pages; clips 1, 2, 3, 7): a room-hire agreement with AcroForm
  fields, a fictional e-mail and phone, and the documentation IBAN
  `GB82 WEST 1234 5698 7654 32` (passes the checksum, so the sensitive-data finder hits it).
- `demo-letter-scan.pdf` (1–2 pages; clips 1, 4): a letter rasterised to greyscale with
  skew, noise and a stamp, built like `lib/scan.ts`; optionally one Turkish page.

The fictional club's name gets a quick search before use. Scenes double as e2e tests and
assert outcomes (the redacted IBAN no longer matches a search; the export verified).

### 2.3 Capture

- `page.screencast.start({ onFrame, size, quality })` (Playwright 1.63), not
  `recordVideo` (fixed-bitrate VP8 smears glyph edges). Frames carry timestamps; the
  recorder writes an ffconcat list with per-frame durations and ffmpeg resamples to 30 fps.
- Viewport 1440×900, `deviceScaleFactor: 2`, Chromium only, `colorScheme: 'dark'`. Clips
  use `reducedMotion: 'no-preference'`; stills use `reduce`. The spike (WP2) checks that
  frames really arrive at 2x; if not, stills come from `page.screenshot` and clips at 1.5x.
- **Cursor**: an SVG pointer injected by the harness follows `page.mouse` with eased steps.
  `showActions` is not used (it draws action titles).
- **Drag ghost**: headless capture has no OS drag image, so the harness draws a
  translucent, slightly scaled copy of the dragged thumbnail under the cursor (DESIGN §3).
  No app code changes.
- **Pacing**: pointer moves 350–500 ms, 600 ms hold after each visible result, 1.2 s on
  the last frame. Waits are on real signals (`toBeVisible`, rendered thumbnails), never on
  timers. Long work (OCR) is cut, not sped up, and the caption says so.
- **Privacy check**: `context.on('request')` logs every URL; the run fails on any origin
  other than the preview server's. The log is published with the media.

### 2.4 Encoding and budgets

| Output | Used in | Format | Budget |
|---|---|---|---|
| Hero still | README, about page, social | PNG 1800 px (`oxipng`); WebP q90 | ≤ 600 KB |
| README clip | README | GIF, 15 fps, 1200 px wide, cropped to what matters | ≤ 3 MB |
| Web clip | about page | MP4 H.264 and WebM VP9, poster WebP | ≤ 1.5 MB |
| Social preview | settings, `og:image` | PNG 1280×640 from `social/template.html` | < 1 MB |

GIFs use ffmpeg's two-pass palette (`palettegen=stats_mode=diff`, then
`paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`); MP4 uses `-crf 20 -preset
slow -pix_fmt yuv420p -movflags +faststart`. The 3 MB GIF limit keeps clear of the image
proxy's 5 MB refusal.
README total on first view ≤ 12 MB (hero plus four GIFs). `tools/media/budgets.json` holds
these limits per output id; `pnpm --filter @pdf-editor/media-tool check` fails on any file
over its limit. The spike compares ffmpeg's palette GIF with gifski on one clip and tests
an animated WebP in a branch README (Chrome, Firefox, Safari, GitHub mobile) before any
switch from GIF. An inline MP4 tour in the README needs a manual upload and is optional.

### 2.5 Layout

```
tools/media/
  package.json          @pdf-editor/media-tool: capture, encode, social, check
  playwright.config.ts  chromium, 1440×900 @2x, UTC, en-US, dark, the preview server
  scenes/               00-hero.still.ts, 01-…08-*.clip.ts: {id, crop, budget, run}
  lib/                  stage.ts, recorder.ts, cursor.ts, frame.ts, encode.ts, privacy.ts
  social/template.html  1280×640 (tokens.css, Inter, glyph)
  budgets.json
  out/                  gitignored
```

Scenes import `openFixtures` and `useFileInputPicker` from `apps/web/e2e/helpers.ts`.

### 2.6 Where media lives

Committing media (about 10 MB per regeneration) or an orphan `media` branch (fetched by
default clones) is rejected; release assets serve as the archive, not as README images.

`deploy.yml` gains a `media` job after `build` on a plain `ubuntu-24.04` runner (not the
Playwright container, whose ffmpeg is stripped): `playwright install --with-deps
chromium`, `apt-get install -y ffmpeg`, serve `dist`, run the scenes, check budgets, add
`media/` to the Pages artifact. The release workflow zips the same files onto the release.
`media/**` is added to Workbox `globIgnores`, so it is never precached. README image URLs
point at the domain (`https://rectopdf.app/media/<id>.gif`).

## 3. The about page (`/about/`)

- A second Vite HTML entry, `apps/web/about/index.html`, beside `main` and `notFound`, so
  `%BASE_URL%`, hashed CSS and `tokens.css` are shared. It loads **no app bundle**: plain
  HTML and CSS, plus at most a few lines of script to pause videos under reduced motion.
- **Same CSP** as the app; no analytics, no fonts from other origins, no embeds. The
  navigation fallback already leaves `/about/` alone; `about/**` is precached (small).
- **Budget**: ≤ 300 KB transferred without videos. Videos use `preload="none"` and a
  poster; the hero clip autoplays muted and loops, and under `prefers-reduced-motion`
  shows only its poster.
- **Sections**: (1) top bar: glyph, name, "Source on GitHub", primary button "Open the
  app"; (2) hero: thesis, one-line list of jobs, the light-table clip, "Chromium, Firefox,
  Safari · No account · Nothing is uploaded"; (3) three facts with evidence links: zero
  requests to other origins (media run log, CI), works offline after one visit
  (`offline.spec.ts`), Apache-2.0 with every dependency listed (`NOTICE`); (4) four
  sections alternating clip and text: Arrange, Redact, Recognise and compare, Sign and
  export, each with "What it does" and "What it does not do"; (5) "Check it yourself" as a
  numbered list; (6) "How it works" as inline SVG; (7) footer: version, release notes,
  roadmap, licence, credits.
- `og:title`, `og:description`, `og:image` (absolute URL to `media/social.png`) and
  `og:site_name` "Recto PDF" on both `/` and `/about/`.
- The app's menu gets one quiet item, **"About this app"**, that opens `/about/` in a new
  tab. No banner. English first; Turkish at `/about/tr/` once the copy settles.

## 4. Repository metadata

- **Description**: "Recto PDF: a PDF editor that runs entirely in your browser. Arrange
  pages across many PDFs, annotate, fill forms, redact, edit text, OCR, compare and sign.
  Nothing is uploaded; works offline. Apache-2.0."
- **Website**: the custom domain.
- **Topics** (20): `pdf` `pdf-editor` `pdf-viewer` `merge-pdf` `split-pdf`
  `pdf-annotation` `redaction` `ocr` `digital-signature` `pdfium` `webassembly` `pwa`
  `offline-first` `local-first` `privacy` `client-side` `tesseract` `react` `typescript`
  `accessibility`.
- **Social preview**: 1280×640 PNG under 1 MB rendered from `tools/media/social/`: glyph,
  name and the thesis in two lines on the left, the light-table still bleeding off the
  right edge; Inter, near-black field, no gradient. Uploaded by hand in Settings → Social
  preview (no API).

## 5. Releases (ADR-0017)

- `.github/workflows/release.yml` on `main`: reads the web package version, creates tag
  `vX.Y.Z[-beta.N]`, builds the notes, and runs `gh release create` with `--prerelease`
  when the version contains `-`. Attachments: `recto-X.Y.Z-dist.zip`, `SHA256SUMS`,
  `recto-X.Y.Z-media.zip`.
- Notes template `.github/release-notes.md`: Highlights · Added · Changed · Fixed ·
  Known limitations · Verify (CI run link, SHA-256 of the dist zip).
- In-app About dialog (palette "About Recto", version line in the privacy popover) with
  the fields of ADR-0017 §6; build-time `define` for version, commit and date, declared
  in `src/pwa/env.d.ts`; strings in English and Turkish.
- `deploy.yml` deploys `main` only. `CONTRIBUTING.md` and `.changeset/README.md` describe
  pre mode and the beta freeze.

## 6. Demo script (8 clips, each under 8 s)

Many files → one table → real changes → honest results. Names follow the M6 UI.

| # | Clip | Beats (the last one is the poster) | Time |
|---|---|---|---|
| 1 | Open many PDFs at once | drop three files on Home → Arrange: three sections | 6.5 s |
| 2 | Move pages between documents | pp. 3–4 dragged with ghost → drop → Export summary | 7 s |
| 3 | Redact, and the text is gone | find sensitive data → apply → IBAN search: none | 6.5 s |
| 4 | Recognise a scan | OCR, English → cut ("shortened") → Good → line selected | 6.5 s |
| 5 | Compare two versions | changed areas → onion skin → J to the changed word | 7 s |
| 6 | Edit a line of text | click a line → "2024" to "2025" → "Same font, verified" | 5.5 s |
| 7 | Sign, and see what was checked | Sign… with test certificate → reopen → "Intact" | 6 s |
| 8 | Pages to Markdown | Convert pp. 2–4 → preview with headings → Copy | 5.5 s |

Documents: clip 1 uses all three, 2 the report and agreement, 3 and 7 the agreement, 4 the
scan, 5 both report versions, 6 and 8 the report. Clip 7 shows the test certificate's label.

The README uses the hero still and clips 2, 3, 4 and 5 as GIFs; the about page uses all
eight as MP4, plus an optional ninth (batch recipes).

## 7. Rename checklist (one pass, after the owner confirms and the domain exists)

| Place | Change |
|---|---|
| `apps/web/vite.config.ts` | manifest `name` and `short_name` "Recto"; description unchanged |
| `apps/web/index.html`, `404.html` | `<title>`, "Open Recto", OG tags (§3) |
| `apps/web/about/` | name in top bar, title, OG tags |
| `apps/web/src/shell/TabBar.tsx` | brand `title` |
| `apps/web/messages/{en,tr}.json` | "PDF Editor" → "Recto" (recipe errors), About strings |
| `apps/web/e2e/smoke.spec.ts` | title expectation |
| Worker names (`engine-service.ts`, clients) | "recto pdfium" etc. (DevTools labels) |
| `README.md`, `NOTICE`, `LICENSE` copyright line | "Recto", "Recto contributors" |
| `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue templates | name and repository URLs |
| `docs/` (VISION, ARCHITECTURE §7, DESIGN §6, DISCUSSION) | name, domain, ADR links |
| `tools/media/social/template.html`, release titles | "Recto" |
| `.changeset/config.json` | repository in the changelog option, if used |
| Repository settings | name `recto`, description, website, topics, preview |

**Not renamed** (ADR-0015 §3): Cache Storage `pdf-editor-ocr`, `-wasm`, `-fonts`;
IndexedDB `pdf-editor-recipes` and OPFS `recipes`; localStorage `pdf-editor:*`; the recipe
format id `pdf-editor-recipe`; file-picker ids; the `@pdf-editor/*` scope; the test PKI's
"pdf-editor Test Signer". A test asserts these names are unchanged after the pass.

## 8. Acceptance

- **Links**: a link checker (lychee or equivalent, in CI) passes on README, `docs/` and the
  built about page; the banned-word grep (§1.3) finds nothing.
- **Image budgets**: `tools/media check` runs in the deploy job and fails on any output over
  `budgets.json`; the README total stays ≤ 12 MB.
- **About page budget**: a Playwright test loads `/about/` from the preview build and
  asserts ≤ 300 KB transferred without videos, no request to another origin, no app bundle
  script, the CSP meta identical to the app's, and posters only under reduced motion.
- **README renders**: a test fetches every image URL in README from the deployed site and
  expects 200 with an image content type; a branch render check on GitHub before merge.
- **Privacy**: the media run's request log contains only the preview origin.
- **Migration** (ADR-0016): old URLs with `?lang=tr` and a hash land on the same view at the
  new origin; `/pdf-editor/sw.js` returns the kill switch, not a redirect; an e2e on the
  redirect folder checks that a registered old worker unregisters and leaves the named
  runtime caches in place.
- **Release**: `v1.0.0-beta.0` exists, marked pre-release, with the notes sections, the
  dist zip and a matching SHA-256; the in-app About shows "Public beta" and that version.

## 9. Work packages and sequencing

| # | Package | Size | Depends on |
|---|---|---|---|
| WP1 | Demo fixtures: `demo-fixtures.ts`, four PDFs, `--check`, provenance | 1 day | — |
| WP2 | Media spike: 2x screencast, GIF vs gifski vs animated WebP, branch render | 0.5 day | WP1 |
| WP3 | Media tool: harness, eight scenes, encode, budgets, privacy log | 2 days | WP2, M6 UI |
| WP4 | CI: `media` deploy job, `release.yml`, notes template, main-only deploy | 0.5 day | WP3 |
| WP5 | About page: entry, sections, OG tags, menu item, budget test | 1 day | WP3 |
| WP6 | In-app About dialog, build-time version, EN/TR strings | 0.5 day | — |
| WP7 | README rewrite, copy review against §1.2–1.3, link checker | 0.5 day | WP3 |
| WP8 | Social template; metadata (manual in Settings) | 2 hours | WP3 |
| WP9 | Portfolio repository with redirect folder and kill switch, e2e | 1 day | domain |
| WP10 | Rename pass (§7) and migration steps (ADR-0016 §5) | 0.5 day | owner, WP9 |
| WP11 | Docs: CONTRIBUTING, `.changeset/README.md`, ARCHITECTURE §7 | 2 hours | WP4 |
| WP12 | Release `1.0.0-beta.0` (ADR-0017 §2) | 2 hours | all |

Order:

1. WP1, WP6 and WP9 in parallel; WP2 after WP1. The owner buys the domain and runs the
   trademark searches meanwhile.
2. WP3 once M6's layout is frozen (the clips show the M6 UI); then WP4, WP5, WP7, WP8.
3. WP10 when the owner confirms ADR-0015 and the domain resolves; the README and about page
   switch to the domain URLs in the same commit.
4. WP11, an independent review of the public copy and the migration, then WP12.

## 10. Out of scope

The portfolio case study (later, same media), the light-theme `<picture>` pair, the Turkish
about page, a hosted tour video, any analytics, a custom domain for the user site.

## 11. Open questions for the owner

1. **Domain**: buy `rectopdf.app` (recommended) or use a subdomain of a personal domain?
   Which registrar? DNS showed `rectopdf.*` unregistered on 2026-10-01; confirm at the
   registrar. Without a domain, ADR-0016's fallback (`/recto/` on github.io) applies.
2. **Social preview**: GitHub has no API for it; the owner uploads the PNG in Settings →
   Social preview after WP8.
3. **Trademark**: search RECTO at the USPTO (classes 9 and 42), EUIPO and TÜRKPATENT before
   the announcement. The research could only use search snippets. A conflict switches the
   name to Kerf in the same rename pass.
