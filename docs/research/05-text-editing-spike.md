---
title: "Research: text editing spike (EmbedPDF 2.15.1 PDFium) for M4 §2"
date: 2026-09-27
status: snapshot
---

> Spike run on 2026-09-27 against `@embedpdf/engines` / `@embedpdf/pdfium` 2.15.1,
> `@cantoo/pdf-lib` 2.11.1 and `@cantoo/fontkit` 2.0.12 in headless Chromium (Vitest browser
> mode). The evidence is `packages/engine/src/pdfium/text-edit.spike.test.ts`: 18 tests, about
> 7 s. Run it with `pnpm --filter @pdf-editor/engine exec vitest run src/pdfium/text-edit.spike.test.ts --silent=false`.
> Numbers are printed as `[spike]` lines. Set `VITE_TEXT_EDIT_SPIKE_PNG=1` to also print the
> before/after renders as base64 PNG. Feeds `docs/specs/redaction-and-text-editing.md` §2.
> Test names are cited as *Describe › test*.

# Text editing spike: what PDFium can do in place, and what Tier 1 needs

## 0. Verdict

| Tier | Go? | Mechanism that works |
|---|---|---|
| Hosting | **Go**, with a guarded private access | `init` + `PdfiumNative` + the `PdfEngine` orchestrator on our own thread. `docPtr` and `pagePtr` come from `PdfiumNative.cache`. |
| Tier 2 (same font) | **Go, but not with whole-object `SetText`** | Split the text object and re-encode the new word in the *original* `FPDF_FONT`. Then verify with a *fresh* text page. |
| Tier 1 (substitute) | **Go** | The same split. The new word goes into a fontkit subset loaded with `FPDFText_LoadCidType2Font`. That adds about 2 KB, keeps reading order, and leaves positions exact. |
| Undo | **Go: reopen + replay** | Replays are byte-identical. There is no API to restore a content stream. |
| Blockers | Type3, text drawn as paths, invisible text: mark them not editable. Forms are Tier 1 only (the text moves to page level). Tagged PDFs need an MCID fix-up. | |

## 1. Hosting (Q1)

*Q1 hosting › the orchestrated direct engine serves the adapter; docPtr/pagePtr are reachable*

- In 2.15.1 the direct class is **`PdfiumNative`**, not `PdfiumEngine`. It implements
  `IPdfiumExecutor`, not the `PdfEngine` interface. `createPdfiumDirectEngine` wraps it in the
  orchestrator: `new PdfEngine(new PdfiumNative(await init({ wasmBinary }), { fontFallback: null }),
  { imageConverter: browserImageDataToBlobConverter })`. All three are exported from
  `@embedpdf/engines`.
- Passing that `PdfEngine` as `engineFactory` runs `PdfiumAdapter.open`, `getPageText`,
  `renderPage`, `createAnnotation` and `save` unchanged. Setup takes 67–159 ms (fetch + `init` +
  constructor, test machine).
- The adapter's `SourceId` is EmbedPDF's document id. So `native.cache.getContext(id)` gives
  `{ docPtr, acquirePage(i) → { pagePtr, getTextPage(), release(), disposeImmediate() } }`.
  The spike's `docContext()` throws if `cache.getContext`, `docPtr` or `acquirePage` is missing.
  Keep it as a canary: the version is pinned exactly.
- **Stale caches.** The executor caches `FPDF_PAGE` and `FPDF_TEXTPAGE` for 5 s. After an edit,
  a text page loaded earlier still returns the old text (`staleReadback` in *Q2 › Helvetica*).
  After every raw edit: call `FPDFPage_GenerateContent`, then `pageCtx.disposeImmediate()`, as
  EmbedPDF's own `redactTextInRects` does. Verification must use a new `FPDFText_LoadPage`.
- **Dangling handles.** An `FPDF_FONT` from `FPDFTextObj_GetFont` dies with its document.
  Reading one after `closeDocument` traps with "null function or function signature mismatch".
- Calling conventions (UTF-16LE `FPDF_WIDESTRING`, `malloc`/`free` via `wasmExports`, heap views
  re-read after every call) are copied from EmbedPDF's `engine.js`. See the spike's helpers.

## 2. Tier 2: in-place `FPDFText_SetText` (Q2)

| Finding | Test |
|---|---|
| Standard-14 Helvetica (not embedded): `fox→cat` round-trips. The re-opened glyph advances equal `FPDFFont_GetGlyphWidth` (±0.01 pt). **0 pixels change outside the edited line** (scale 2; the excluded box runs from the line start to the right page edge, because `SetText` re-flows the object). | *Q2 › Helvetica (standard 14)…* |
| A character the font cannot encode is **not rejected**. `SetText` returns true. Helvetica writes U+03A9 as code `0xFF` and it renders and extracts as `ÿ`. An Identity-H subset (pdf-lib, Inter) writes **CID 0** for `a` and `t`, which are absent from the subset. Those chars are dropped from rendering and text (`c jumps`, see `tier2-subset-missing-after.png`). | *Q2 › missing glyphs…* |
| Pre-check signals: `FPDFFont_GetGlyphWidth` **succeeds with a bogus width** for missing chars (3.336 at 12 pt for Ω in Helvetica; DW = 20 at 20 pt in the subset). `FPDFFont_GetGlyphPath` returns **null** for them, and a non-null path with >0 segments for present glyphs. Post-check: a fresh text page's `FPDFTextObj_GetText` shows the damage (`ÿox`, `c`). | same |
| Tagged PDF: `/P <</MCID 0>> BDC … EMC` and the `/Artifact` BDC survive. After reopening, the objects report MCIDs `[0, -1]`. | *Q2 › tagged PDF…* |
| **`SetText` flattens `TJ` kerning** into one `Tj`. The glyphs after the edit move by the sum of the adjustments: 0.180 pt = abs(30 − 40 + 25) / 1000 × 12. Real documents (Word, LaTeX) kern heavily, so whole-object `SetText` is not an exact Tier 2. | *Q2 › SetText flattens TJ kerning…* |
| `GenerateContent` **re-serialises the whole page**. Font resources are renamed (`/Helvetica-7098480789` → `/FXF1`), `/FXE1 gs` and `1 w 0 J 0 j` are added, and each object becomes `q … cm BT 1 0 0 1 0 0 Tm … Tj ET Q`. A two-stream `/Contents` is merged into **one** stream. Inflated size goes 504 → 526 B (simple-text p1) and 11,156 → 17,054 B (+53 %, dense page). | *Q2 › Helvetica…*, *Q2 › GenerateContent merges…*, *Q4 › cost* |
| Without edits, `saveAsCopy` leaves the content stream byte-identical. Only regenerated pages change. | *Q4 › edits replay byte-identically…* |

## 3. Tier 1: remove and replace (Q3)

**Removal.** EmbedPDF's public `engine.redactTextInRects(doc, page, rects, { recurseForms: true,
drawBlackBoxes: false })` removes exactly the glyphs inside the rect. The rect is inset 0.5 pt so
the neighbouring spaces are kept. The gap becomes a `TJ` displacement (`… 20> -1334 <206A…`,
where 1334 is the width of "fox" in 1/1000 em). The existing kerning (30, 25) is kept, and the
surviving glyphs move by **< 0.01 pt**. This held for Helvetica, a TJ-kerned line and an
Identity-H subset, in 2–9 ms (*Q3 › redactTextInRects removes only…*).

**But appending the new word breaks reading order.** A pdf-lib post-pass `drawText` and a PDFium
`FPDFPage_InsertObject` both extract as `…the lazy dog. wolf`. Sizes, starting from the 2,801 B
removed file: pdf-lib with a fontkit subset gives **4,209 B** (+1.4 KB, 18 ms, one extra full
parse and serialise). PDFium `FPDFText_LoadFont` gives **102,385 B** (+99.6 KB). That call embeds
the whole 177 KB TTF: `FontFile2` is 88.7 KB after Flate, with a full `/W`. Only the old/new
sizes and the font-dictionary summary were measured; subsetting that font afterwards was not
tried. Doing it would mean renumbering glyphs and rewriting every charcode in the content, so do
not embed full fonts (*Q3 › appending the replacement…*).

**What works: split + subset, all in PDFium** (*Q3 › split + bundled subset…*). Each edit takes
these steps:
1. `FPDFText_GetTextObject` gives the object of the selected chars. Get the per-char unicode and
   `FPDFText_GetCharOrigin`, then the object's `FPDF_FONT`, size, matrix, fill colour, render
   mode and MCID.
2. Group the prefix and suffix chars into **runs**, starting a new run wherever a glyph's origin
   is not the previous origin plus its advance. Each run becomes an `FPDFPageObj_CreateTextObj`
   with the *same* font, filled by `FPDFText_SetText`, which maps unicode back to charcodes. Set
   its matrix to the run's first origin with the original linear part. This reproduces `TJ`
   kerning exactly: the kerned line needs 2 + 2 runs.
3. Build the replacement from a **fontkit subset** of a bundled face (578–706 B). Load it with
   `FPDFText_LoadCidType2Font(doc, ttf, toUnicodeCMap, cidToGidMap)` and fill it with
   `FPDFText_SetCharcodes`. PDFium writes `/W` itself. With an empty CIDToGIDMap it returns 0
   (*Q4 › abandoning…*).
4. Insert everything with `FPDFPage_InsertObjectAtIndex` where the original object was. Remove
   the original with `FPDFPage_RemoveObject`, or `FPDFFormObj_RemoveObject` for text in a form.
   Check a fresh text page, then call `GenerateContent`.

The results are the same on Helvetica, TJ-kerned, Identity-H subset, tagged, `/Rotate 90` and
Form XObject pages (scaled 1.5 by `cm`):
- the fresh text page equals the re-extraction;
- the line reads in order (`The quick brown wolf jumps…`);
- surviving glyphs drift by ≤ 6·10⁻⁵ pt;
- the new glyph boxes fall inside the original line box;
- the old word is absent from the page stream (raw hex/literal grep);
- **0 pixels differ outside the line box**;
- `GenerateContent` takes 0.2–1.1 ms;
- files grow by 1.7–2.7 KB.

PNGs are listed in §8. Caveats found:
- **Shrink-to-fit is severe with substitutes.** Inter "wolf" needs 7.9 pt to fit Helvetica "fox"'s
  12 pt slot (`tier1-kerned-after.png`). The spec's 90 % floor would force overflow here.
- **The subset's BaseFont is `/Untitled`**, taken from the fontkit subset, which has no `name`
  table, and it has no `ABCDEF+` tag. Rename it in a post-pass, or build the subset with a name.
- **Tagged PDF: the MCID is duplicated.** Each new object gets its own `/P <</MCID 0>> BDC … EMC`,
  so the content has three sequences with MCID 0. The public API cannot share one mark between
  objects.
- **Form XObjects:** the split text moves to *page level*, right after the `Do`, and the form
  stream is rewritten without it (`forms` = `['']` in the test).

**The same split with the original font is the exact Tier 2** (*Q3 › split with the original font…*).
On the kerned line, `fox→cat` gives drift < 0.01 pt, no new font in the file, and 2 + 2 runs. A
missing glyph (`Ω`) is still silently written as `ÿ`, and the fresh-text-page check catches it.

**Whole-file residue** (*Q3b › one edit leaves no trace…*): after one edit the old word is in no
stream of the file (all indirect objects, decoded). After **two `GenerateContent` calls on the same
page in one session** (fox → cat → owl), the intermediate stream (`cat`) is still written as an
unreachable object. This matches 06-redaction-spike §2 #801. A reopen + `saveAsCopy` round trip
drops it.

## 4. Undo and replay (Q4)

- Replaying the same edit on freshly opened original bytes gives **byte-identical** output, for
  Tier 2 and for split + subset (*Q4 › edits replay byte-identically…*). PDFium has no call to put
  back a content stream. The only in-session "undo" is abandoning *before* `GenerateContent`:
  `disposeImmediate()` drops object edits. A font loaded for the edit **stays in the file** anyway
  (2,877 → 4,525 B, `/Untitled` present; *Q4 › abandoning…*). **So undo = reopen the source bytes +
  replay the remaining `EngineEdit`s.** The spec's "original content stream segment restored"
  inverse is not implementable through PDFium.
- Cost (*Q4 › cost*), many-pages.pdf (400 pages, object streams, inherited resources):
  - open: 7–9 ms;
  - `GenerateContent` after a `SetText` on every page: median 5.1–5.5 ms, max 9.6–17.8 ms,
    2.2–2.3 s in total;
  - `saveAsCopy`: 18–19 ms.
  - A dense Letter page (60 lines × 12 `TJ`-kerned words) needs 1.3–1.7 ms per `GenerateContent`.

  The cause of the higher per-page cost on many-pages.pdf was not investigated. Replaying a
  session of tens of text edits costs tens to hundreds of ms.
- `saveAsCopy` writes no object streams: many-pages.pdf grows 66 → 98 KB with no edit at all. All
  400 pages edited gives 217 KB.

## 5. Blockers (Q5)

| Case | Finding | Test |
|---|---|---|
| Text in a Form XObject | `FPDFText_GetTextObject` returns the object *inside* the form (`FPDFFormObj_GetObject(form, 0)`). **`SetText` on it is visible in memory but lost on save**: `GenerateContent` does not rewrite the form. `FPDFFormObj_RemoveObject` does get the form rewritten. `FPDFPage_RemoveObject` on it returns false. `redactTextInRects({recurseForms:true})` rewrites the form stream too. ⇒ Tier 1 only, as the spec says. | *Q5 › Form XObject…* |
| Render mode 3 (OCR layer) | `FPDFTextObj_GetTextRenderMode` = 3. It survives `SetText` + `GenerateContent` (`3 Tr`). Text stays extractable. | *Q5 › text render mode 3…* |
| Type3 | `FPDFFont_GetBaseFontName` = "", embedded = true, flags 0, `GetFontData` length **0**, glyph width 0, glyph path null. Text still extracts. Detect it as embedded with 0 font-data bytes. | *Q5 › Type3…* |
| Rotated pages | On `/Rotate` 0/90/180/270, `FPDFText_GetCharOrigin` is (72, 760) and the object matrix is `[1 0 0 1 72 760]`: unrotated user space, because the adapter opens without `normalizeRotation`. Tier 1 on `/Rotate 90` passes (§3). | *Q5 › char origins…*, *Q3 › split…* (rotated) |

## 6. Recommended engine design for M4

**Where the raw module lives.** In one module instance with the renderer: edits, rendering and
saving must share the same `FPDF_DOCUMENT`. Replace EmbedPDF's blob worker with **our own Comlink
worker**. It hosts `init` + `PdfiumNative` + `PdfEngine`, a `PdfiumAdapter` built with
`engineFactory: () => engine`, and a `PdfTextEditor` that reaches `docPtr`/`pagePtr` through the
guarded `docContext()`. Raw edits must not interleave with queued `PdfEngine` tasks. The spike was
sequential: run edits as tasks on the same queue, or hold a per-document lock. Guard the private
layout with the Q1 test and keep `@embedpdf/*` pinned.

```ts
interface TextRunRef { source: SourceId; pageIndex: number; objectPath: readonly number[]; // page index[, form index]
  charStart: number; charCount: number; text: string } // text = expected, re-checked on replay
interface LocatedRun extends TextRunRef {
  lineBox: Rect; glyphs: readonly Glyph[]; fontSize: number; matrix: Matrix;
  font: { baseName: string; embedded: boolean; kind: 'standard14' | 'embedded' | 'type3' | 'not-embedded' };
  renderMode: number; mcid?: number; inForm: boolean }
type Honesty = 'same-font' | 'font-substituted' | 'not-editable';
interface Editability { tier2: { ok: true } | { ok: false; missing: readonly string[] };
  tier1: { ok: true; substitute: BundledFace } | { ok: false; reason: 'type3' | 'invisible' | 'vertical' | 'nested-form' };
  honesty: Honesty }
interface TextEditRequest { run: TextRunRef; start: number; end: number; replacement: string;
  tier: 'auto' | 1 | 2; fit: 'shrink' | 'overflow' }
interface TextEditResult { tier: 1 | 2; honesty: Honesty; substitute?: string; fontSize: number;
  verification: { readback: string; maxDrift: number; insideLineBox: boolean } }
interface PdfTextEditor {
  locateRuns(source: SourceId, pageIndex: number): Promise<readonly LocatedRun[]>; // per text object, user space
  checkEditability(run: LocatedRun, replacement: string): Promise<Editability>;    // glyph-path pre-check
  applyTextEdit(req: TextEditRequest): Promise<TextEditResult>; // split, fresh-text-page verify, then GenerateContent
}
```

`applyTextEdit` follows the §3 recipe. With `tier: 'auto'` it tries the original font first
(Tier 2). If the pre-check (glyph path per non-space char) or the fresh-text-page readback fails,
it drops the uncommitted objects, closes the page *without* `GenerateContent`, and retries with the
bundled subset (Tier 1). It reports `font-substituted`. Honesty states for the UI:
- **same font**: Tier 2, verified;
- **font substituted: Inter**: Tier 1;
- **not editable**: Type3, text drawn as paths, render mode 3 (see open questions).

Record each edit as a new `EngineEdit` kind `text.edit`, with the `TextRunRef` + replacement +
tier + face. It is non-invertible: history undoes it by reopen + replay (§4). On export, apply all
text edits of a page before one `GenerateContent`, or garbage-collect: reopen + `saveAsCopy`, or
pdf-lib `dropUnreachable` as 06 proposes. Then rename `/Untitled` to `XXXXXX+Inter-Regular`.

## 7. Risks

1. **Private API.** `PdfiumNative.cache` and `PageContext` are private. An EmbedPDF update can
   break the editor at runtime (canary: Q1).
2. **Full-page re-serialisation.** Every edited page is rewritten, and its streams are merged. The
   spike did not check whether inline images, shadings, unusual operators or `BX/EX` sections
   survive `GenerateContent`.
3. **Silent wrong glyphs.** `SetText` never fails on unencodable characters. Skipping the
   fresh-text-page check ships `ÿ` or dropped glyphs.
4. **Tagged PDFs.** A split repeats the MCID across sequences. A structure-tree fix-up (new MCIDs,
   `/K` + `/ParentTree`) is needed. That fix-up was not built.
5. **Form XObjects.** The text moves out of the form, which loses the form's clip, transparency
   group and reuse. The spike did not test a form shared by several pages. Removing an object
   from a shared form would change every page that draws it.
6. **In-session orphans.** A second `GenerateContent` on a page leaves the previous stream, with
   its text, in the saved file. The fix is GC on export.
7. **Substitute width.** Bundled faces can be much wider than the original. Shrink-to-fit at 90 %
   will rarely fit, so the UI must offer overflow.
8. **Reading order** was verified with PDFium extraction only, not pdf.js or other readers.

## 8. Open questions

- Should Tier 2 be allowed for *non-embedded* standard-14 fonts? It is verified to work for
  WinAnsi characters, but spec §2.1 requires embedding.
- Should render-mode-3 OCR text be editable (as invisible Tier 2), or excluded?
- Not covered for lack of fixtures:
  - simple TrueType/Type1 subsets with `/Differences`;
  - CID fonts without `/ToUnicode` or with duplicate mappings (`SetText`'s reverse lookup may not
    round-trip; the readback check would catch it);
  - vertical writing;
  - `Tz`/`Tc`/`Tw` (runs keep positions, but horizontal scaling was not tested);
  - nested forms.

  The M4 corpus (`text-edit-fonts.pdf`, `text-edit-rotated.pdf`, in progress in another session)
  should close these.
- Why is `GenerateContent` 3–4× slower on many-pages.pdf pages than on a dense page?
- PNG evidence, written only with the env flag, is in the spike's scratch directory:
  - `tier2-helvetica-{before,after}.png`
  - `tier2-subset-{before,after}.png`
  - `tier2-subset-missing-{before,after}.png`
  - `tier1-{helvetica,kerned,subset,tagged,rotated,form}-{before,after}.png`

  Regenerate them with the command in the header.
