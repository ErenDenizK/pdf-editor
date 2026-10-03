---
title: "Research: paragraph text editing (reflow, overflow, fonts) beyond the single line"
date: 2026-10-03
status: snapshot
---

> Research snapshot gathered on 2026-10-03. Most vendor help sites (Adobe, Foxit, Iceni,
> Wondershare, Readdle) were blocked by the egress proxy, so vendor behaviour comes from
> search-engine excerpts of the cited pages and from community threads; general knowledge is
> marked as such. Source code was read directly (PDFium headers and `fpdf_edittext.cpp`,
> pdfminer.six, PDFBox, pdfplumber, pdf.js, PyMuPDF docs), as were the exports of
> `@embedpdf/pdfium` 2.15.1 and `@cantoo/fontkit` 2.0.12 in `node_modules` and versions on
> registry.npmjs.org. Builds on `05-text-editing-spike.md` and
> `docs/specs/redaction-and-text-editing.md` §2, whose "tier 1/2" are Tier A here and whose
> "tier 3" is Tier B. Decisions belong in `docs/adr/`.

# Paragraph text editing: how close a PDF can come to Word

## 0. Verdict

**For the owner, in plain words.** A PDF is a finished print, not a document that is still
being written. Every line sits at a fixed spot on a fixed page. The file does not remember
which lines form a paragraph, where the margins were, or which paragraph continues on the next
page. Editors that "edit like Word" guess all of this from the positions of the letters.

| You asked for | Possible? | How it will feel |
|---|---|---|
| Click a text in edit mode and the whole paragraph opens | **Yes**, for most PDFs exported from Word, Google Docs, LibreOffice or a browser | A box appears around the paragraph. Recto guesses the paragraph from the layout, and uses the file's own paragraph tags when it has them. Sometimes the guess is wrong (two columns, lists, captions), and you can fix it with one gesture. |
| Edit freely, no font or size worries | **Yes, when the file contains the letters you type** | Recto keeps the paragraph's font, size, colour, spacing and alignment. Files usually carry only the letters they used. If you type a letter the file lacks, Recto says so and offers the closest bundled font (or yours) for those letters. |
| Text rewraps like in Word | **Yes, inside the paragraph** | Lines rewrap from the edit point on. Lines before your edit do not move at all. |
| The paragraph grows and later text moves down | **Partly, same page only** | When there is empty space below, Recto can move the following blocks on that page down (Tier C). If there is no room, it tells you and offers to tighten the spacing slightly or let the text overlap. |
| Pages shift like a Word document | **No** | No PDF editor does this for PDFs in general, Adobe Acrobat included. Headers, footers, page numbers, figures and footnotes are printed onto each page as ordinary text and pictures. The rules that placed them are gone. To change the page flow, edit the original Word file, or convert to Word and accept the conversion losses. |
| "As if I had created the file myself" | **Yes for small and medium edits in the original font**, not for rewrites | With the original font and a reflow that stops as soon as the lines match the old ones again, the result is very hard to tell from the original. With a substituted font, it is an honest, visible patch. |

**For engineering.**

| Tier | Scope | Status / effort (one experienced engineer) |
|---|---|---|
| **A** | Single line, same font or bundled substitute, split + verify (M4) | Done (`packages/engine/src/text-edit/`, about 6.5k lines with tests) |
| **B** | Paragraph box: detect the paragraph, edit with style runs, reflow inside the box, automatic font (original, else per-glyph substitute), overflow policy | **10–14 engineer-weeks**, including a glyph-exact canvas overlay and a corpus |
| **C** | Push-down: move the blocks below the paragraph on the same page into free space, annotations and links included | **+4–6 weeks** on top of B |
| **D** | Reflow across pages | **Not feasible** in general (§1.3). User-linked boxes, as in Foxit or Infix, are possible but not recommended now. |

The sentence to show users is in §7.4.

## 1. What a PDF is, structurally

### 1.1 Word concepts versus PDF reality

| Word processor | PDF page content |
|---|---|
| Paragraphs, styles, margins | None. A content stream of operators: `BT … ET` text objects, `Tf` (font, size), `Tm`/`Td` (position), `Tj`/`TJ` (show glyphs), `Tc`/`Tw`/`Tz` (character, word, horizontal spacing), `TL` (leading). A "line" exists only because glyphs happen to share a baseline. |
| Text flow, page breaks | None. Each page is independent and its glyphs have absolute coordinates. |
| Kerning, justification | Already applied. `TJ` arrays carry offsets in thousandths of an em between glyphs; justified lines are spread by `Tw`, by `TJ` offsets or by positioning each word separately. |
| Fonts | Usually **subsets** (`ABCDEF+Name`) holding only the glyphs used. Advances come from the PDF `/Widths` or `/W` arrays, not from the font program. `/ToUnicode` is optional and sometimes wrong. Simple fonts have at most 256 codes; Type0/Identity-H fonts use 2-byte codes. |
| Characters | Glyphs. A ligature `fi` is one glyph; a hyphen at a line end is a real glyph. Text can also be **Type3** (each glyph is a little drawing), **outlined paths** (no text at all), or **invisible** (render mode 3, the OCR layer over a scan). |
| Semantics | Only in **tagged PDF**: an optional structure tree (`/P`, `/H1`, `/L`, `/LI`, `/Table` …) linked to content through marked-content IDs (MCIDs). Content-stream order need not be reading order. |

### 1.2 Producers decide what is editable

| Producer | Typical shape | Paragraph editing outlook |
|---|---|---|
| Word (Save as PDF; "Document structure tags for accessibility" is on by default in current versions) | Tagged, `/P` per paragraph; one text object per line or run; TrueType subsets; justified lines spread by word positioning or `Tw` | **Best case.** Tags give paragraphs for free. |
| Chrome "Save as PDF" (tagged since Chrome 85, [Chromium blog](https://blog.chromium.org/2020/07/using-chrome-to-generate-more.html)), LibreOffice with tagging on | Tagged, subsets, many small runs | Good |
| LaTeX (pdfTeX, LuaTeX) | Untagged unless the author opted in; Type1/CFF subsets; heavy `TJ` kerning; Knuth–Plass justification; hyphenation; ligatures | Paragraphs detectable; faithful re-typesetting is hard (justified, hyphenated, ligatures, CFF fonts) |
| InDesign, Illustrator, print workflows | CFF/OpenType subsets, often text converted to outlines, threaded frames, mixed columns | Often not editable (outlines); multi-column traps |
| Scans with OCR | A picture plus invisible text (render mode 3) | Not paragraph-editable: the visible "text" is pixels |
| Reports, invoices from generators | One text object per field or word, standard-14 fonts, absolute layout | Lines editable; "paragraphs" are often table cells |

### 1.3 Why Word-like cross-page reflow is impossible in general

1. **No flow record.** Nothing says that the last line of page 3 continues on page 4, or that a
   column continues in the next one. Infix and Foxit ask the *user* to link boxes in order
   (§2) for exactly this reason.
2. **Page furniture is ordinary content.** Running headers, footers, page numbers and footnotes
   are glyphs at fixed coordinates on each page. Well-tagged files mark them `/Artifact`;
   in all other files they look exactly like body text.
3. **Floats and decisions are lost.** Where figures and tables sit, widow and orphan control,
   keep-with-next, and footnote placement were decided by the original program's rules, which
   the PDF does not contain.
4. **Cross-references are frozen.** Tables of contents, "see page 7", indexes, bookmarks and
   link destinations point to page numbers and coordinates.
5. **Fonts are partial.** Text pushed to a later page must be re-typeset there, with the same
   missing-glyph problem multiplied.
6. **Integrity.** Signed PDFs are invalidated by any content change. Moving content across
   pages also breaks highlights, comments and form fields anchored to page coordinates.

**The real-world ceiling** is what Acrobat ships: reflow *inside* a detected paragraph box,
with the box independent of everything else. Adobe states that "inserting text in one text
block doesn't push down an adjacent text box or reflow to the next page" ([Adobe
help](https://helpx.adobe.com/acrobat/current/edit-text-pdfs.html), via search excerpt).
Same-page push-down (Tier C) goes slightly beyond that ceiling on simple single-column pages.

## 2. What existing editors do

| Editor | Paragraph detection | Reflow in paragraph | Across paragraphs / pages | Fonts | Edit-mode entry |
|---|---|---|---|---|---|
| **Adobe Acrobat Pro** (Edit) | Yes, guessed: it merges runs by proximity "unless the document content is properly tagged", and users cannot turn the merging off ([community](https://community.adobe.com/t5/acrobat/why-does-acrobat-keep-merging-nearby-text-boxes-in-edit-mode/m-p/12037319)) | Yes, inside the box | No: boxes are independent; growing text overlaps the box below ([community](https://community.adobe.com/t5/Acrobat/How-can-I-stop-overlapping-textboxs-when-I-add-new-line-on-Adobe/m-p/10426284)) | Needs the font **installed**: embedded but not installed means colour and size only; neither means not editable; unavailable fonts fall back per script (Minion Pro for Latin), configurable in Preferences › Content Editing ([Adobe help](https://helpx.adobe.com/acrobat/using/edit-text-pdfs1.html), search excerpt). Subsets may block "less-used characters, such as a capital Z" ([acrobatusers](https://acrobatusers.com/forum/general-acrobat-topics/editing-text-pdf-documents/)) | Explicit Edit tool; blue bounding boxes on every block |
| **Foxit PDF Editor** | Yes (Edit Text works per paragraph); Edit Object works per object | Yes, "as your changes reach the text boundary" | **Link & Join Text**: link numbered blocks, "not only on one page but also across pages, and text will reflow in these linked blocks"; Join merges blocks into one paragraph; Split separates ([Foxit blog](https://www.foxit.com/blog/how-to-link-and-join-text-objects/), search excerpt) | System fonts; optional auto-embedding on save ([Foxit blog](https://www.foxit.com/blog/control-how-fonts-are-handled-in-your-pdfs/)) | Explicit Edit tab |
| **Infix PDF Editor** (Iceni) | Reflow scope "Containing Paragraph" or "Containing Line"; paragraph mode "only … when confident that the paragraphs are well formed" ([Iceni help](https://www.iceni.com/help/Infix/7/en/ReflowAlignment.html), excerpt) | Yes | **Linked text chains** across columns and pages, numbered in flow order; overset text flagged by a red square; links persist with "Store layout in PDF" ([Iceni](https://www.iceni.com/help/Infix/7/en/Editingacrosscolumnspages.html), [overset](https://www.iceni.com/help/Infix/7/en/Oversettext.html)). No automatic push-down was documented | **Remap Fonts** repairs glyph-to-character maps, with OCR auto-correct since 7.1.6 ([Iceni](https://www.iceni.com/help/Infix/7/en/Remappingfonts.html)); Text Fitting tightens letter spacing ("the equivalent of -35" on its spacing palette), then optionally font size and line spacing ([Iceni](https://www.iceni.com/help/Infix/7/en/TextFitting.html)) | Explicit text tool |
| **PDF-XChange Editor** | Edit Text groups objects into flow blocks; since v10 separate from Edit Objects. The tool emulates paragraphs over separate text objects; there is no real PDF paragraph object ([forum](https://forum.pdf-xchange.com/viewtopic.php?t=46544)) | Yes | Not documented | Not verified | Explicit tool |
| **Wondershare PDFelement** | **Line mode / Paragraph mode** toggle ([Wondershare](https://support.wondershare.com/how-tos/pdfelement/edit-text-with-different-modes-pdfelement-windows.html)) | Yes in paragraph mode | No | System fonts | Explicit Edit |
| **PDF Expert** (Readdle) | Click = paragraph ("intelligent mechanism"); Option-click = single line ([Readdle](https://support.readdle.com/pdfexpert/en_US/edit-pdfs/edit-text-in-pdf-files)) | Yes | No | Detects font, size, opacity; falls back when the font is not installed; iOS cannot use third-party fonts ([Readdle](https://support.readdle.com/pdfexpert/en_US/troubleshooting/garbled-text)) | Explicit Edit mode |
| **Nitro PDF Pro** | Yes | Yes, "within the bounding box as you edit or resize it" | No | Similar font, else generic ([Nitro](https://www.gonitro.com/user-guide/pro/article/add-or-edit-text-in-a-pdf), excerpt) | Explicit Edit |
| **Apple Preview** | No editing of existing text (annotations only; general knowledge) | — | — | — | — |
| **Sejda / PDFgear / Smallpdf / iLovePDF** | Box per paragraph or line | Within the box | No | Sejda: embedded fonts "may contain missing characters", pick a replacement; local fonts only in the desktop app ([Sejda](https://www.sejda.com/pdf-editor)). PDFgear: system fonts ([PDFgear](https://www.pdfgear.com/pdf-editor-reader/edit-pdf-text-with-same-font-online.htm)). iLovePDF refuses when "embedded fonts do not allow text editing" ([iLovePDF](https://www.ilovepdf.com/blog/edit-pdf-text)) | Explicit edit tool |
| **LibreOffice Draw** | No: every line becomes a text box | No | No | Missing fonts shift layout (research 02) | Opens as a drawing |
| **Stirling-PDF 2.0** (alpha) | Glyphs grouped into words by a fixed x-gap; box resizing disabled after it split letter-spaced headings ([#8324](https://github.com/Stirling-Tools/Stirling-PDF/issues/8324)) | Limited | No | — | Explicit editor |

**Open-source engines** offer no paragraph editing. pdf.js gives text items with `hasEOL` and
cannot edit existing text. PDFium gives characters and primitives (`FPDFText_SetText`,
`FPDFPageObj_*`, `FPDFFont_*`), no paragraphs. MuPDF's stext blocks approximate paragraphs, but
replacing text means redaction plus `insert_htmlbox`, whose Story layout flows HTML through
rectangles ([Artifex](https://artifex.com/blog/mastering-pdf-text-with-pymupdfs-insert-htmlbox-what-you-need-to-know)); it is AGPL. pdfcpu and pdf-lib write new
content but do not parse or reflow existing text. BentoPDF 2.8.8 claims live reflow with font
matching, with local fonts on Chromium only (research 02).

**Lessons.** (1) Everyone stops at the box: cross-page flow exists only as user-linked boxes
(Foxit, Infix). (2) Paragraph guessing is the top complaint (Acrobat's merges cannot be undone).
Recto must make the grouping visible before editing and cheap to correct. (3) Font honesty
varies. Acrobat refuses edits it cannot do in the real font; the online tools substitute
quietly. Recto's verified tiers already beat both. (4) Edit mode is always explicit, with boxes
drawn on every block, so nobody edits by accident.

## 3. Paragraph detection

### 3.1 Order of evidence

1. **Tagged PDF.** When the page has a structure tree (`FPDF_StructTree_GetForPage`,
   `FPDF_StructElement_GetType`, `…GetMarkedContentIdAtIndex`, `FPDFPageObj_GetMarkedContentID`,
   all exported by `@embedpdf/pdfium` 2.15.1), the text objects whose MCIDs belong to one `/P`,
   `/LI` (`/LBody`) or `/H1…6` form one paragraph. Check the tags against geometry: drop a tag
   group whose lines are not vertically contiguous on the page, since some producers tag badly.
2. **Geometry heuristics** (below) for untagged files, or where tags fail the check.
3. **User correction**: split here, or join with the next block (Foxit's Join/Split).

### 3.2 What existing tools use

| Tool | Rule (defaults) |
|---|---|
| pdfminer.six `LAParams` | `line_overlap` 0.5 (same line if vertical overlap > 0.5 × min height), `char_margin` 2.0 (same line if gap < 2 × char width), `word_margin` 0.1, `line_margin` 0.5 (same paragraph if line gap < 0.5 × line height), `boxes_flow` 0.5 for ordering ([layout.py](https://github.com/pdfminer/pdfminer.six/blob/master/pdfminer/layout.py)) |
| pdfplumber | `x_tolerance` 3, `y_tolerance` 3 pt for words and lines (built on pdfminer) ([text.py](https://github.com/jsvine/pdfplumber/blob/stable/pdfplumber/utils/text.py)) |
| Apache PDFBox `PDFTextStripper` | New paragraph when the vertical gap > `dropThreshold` 2.5 × line height, or the start is indented > `indentThreshold` 2.0 space widths (a hanging indent if the previous line began a paragraph), or starts left of the previous start by > 1 space; repeated list markers also split ([source](https://github.com/apache/pdfbox/blob/trunk/pdfbox/src/main/java/org/apache/pdfbox/text/PDFTextStripper.java)) |
| PyMuPDF / MuPDF | Blocks are "roughly paragraphs": block → line → span; `TEXT_DEHYPHENATE`, `TEXT_SEGMENT` flags ([app1.rst](https://github.com/pymupdf/PyMuPDF/blob/main/docs/app1.rst)) |
| pdf.js | Only spaces and line ends: a gap ≤ 0.102 × font size is tracking, not a space; a shift beyond 0.25 × height starts a new line (`hasEOL`) ([evaluator.js](https://github.com/mozilla/pdf.js/blob/master/src/core/evaluator.js)) |
| Literature | XY-cut (recursive splits along whitespace valleys); Docstrum (nearest-neighbour clustering, O'Gorman 1993, [S2](https://www.semanticscholar.org/paper/The-Document-Spectrum-for-Page-Layout-Analysis-O'Gorman/d85097da36118fbccfeb7802abf89bf4b4c63a3e)); whitespace cover by maximal empty rectangles (Breuel 2002, [Springer](https://link.springer.com/chapter/10.1007/3-540-45869-7_23)); Tesseract's tab-stop detection to find columns (Smith 2009, [PDF](https://tesseract-ocr.github.io/docs/PageLayoutAnalysisICDAR2.pdf)) |

### 3.3 Rules for Recto (geometry path)

Work in user space per page, horizontal text only (other text stays Tier A).

1. **Lines.** Group text objects (already per run in Tier A) whose baselines differ by
   < 0.2 × font size and whose horizontal gap < 1.5 × the line's median space width. Break a
   line at gaps > 3 × space width: these are column gutters or tab stops.
2. **Columns first.** Find vertical whitespace channels (XY-cut on line boxes, minimum width
   2 × median space and height ≥ 3 lines). Never merge lines across a channel.
3. **Join line *n+1* to the paragraph of line *n*** when all of these hold:
   - same dominant font family and size (±0.5 pt), or the same style-run mix;
   - baseline gap within ±15 % of the paragraph's running leading (the first pair sets it,
     and it must be ≤ 1.6 × font size);
   - left edges aligned within 1 space width, *or* line *n* is the paragraph's first line and
     line *n+1* is left of it (first-line indent), *or* line *n+1* is right of a first line
     that starts with a list marker (hanging indent);
   - line *n* is not "short": its right edge reaches ≥ 85 % of the paragraph's measure, unless
     the paragraph is centred or right-aligned;
   - line *n+1* does not start with a list marker (`•`, `–`, `1.`, `a)`, `(i)`).
4. **Alignment.** Classify each paragraph as left, right, centred or justified from the
   variance of the left and right edges across its non-final lines (justified: both < 0.5 pt).
5. **Measure.** The box width is the maximum line extent, widened to the column channel when
   the text is justified or ragged-right with a shared right limit.
6. **Show it.** Hovering in edit mode outlines the detected paragraph; Alt/Option-click edits a
   single line (PDF Expert's convention), which is Tier A.

### 3.4 Known failure modes

| Case | Failure | Mitigation |
|---|---|---|
| Two columns, narrow gutter | Lines merged across columns | Column channels first (rule 2); tags win when present |
| Captions under figures | Caption joined to the body | Font size/style change; whitespace gap > 1.5 × leading |
| Lists | Items merged into one paragraph | List-marker regex; hanging-indent rule |
| Drop caps | Big first letter is its own "paragraph" and indents three lines | Attach a glyph ≥ 2 × body size whose box spans *n* body lines; keep it fixed and reflow around its indent; or refuse paragraph mode |
| Justified text | Mistaken for word positioning; spaces are not glyphs | Measure from glyph origins; treat inter-word gaps as stretchable glue |
| Tables | Cells merged into rows of "paragraphs" | Ruling lines (paths) and column channels split cells; edit cells as separate boxes |
| Text in Form XObjects, rotated or vertical text, Type3, outlines | Not safely re-typesettable | Tier A rules apply; paragraph mode refuses with the reason |

## 4. Re-typesetting a paragraph in the browser

### 4.1 Measuring

Advances must come from the **PDF widths**, because they are what viewers use, not from the
font program. `FPDFFont_GetGlyphWidth` returns `GetCharWidthF(charcode) × size / 1000`, but it
takes a **Unicode code point** and maps it back through the font's ToUnicode
(`CharCodeFromUnicode` in [fpdf_edittext.cpp](https://github.com/chromium/pdfium/blob/main/fpdfsdk/fpdf_edittext.cpp)).
That mapping is ambiguous for ligatures and duplicated glyphs. Recto's Tier A already reads the
original **codes** and their widths from the content stream (`text-edit/codes.ts`,
`analysis.ts`). Tier B should measure in codes too, and use `FPDFText_GetCharBox` and
`GetLooseCharBox` only to check geometry. A second caveat: `FPDFFont_GetGlyphPath` may return
the path of a *fallback* font (`fallback_font_position_ != -1`). A non-null path is therefore a
good signal of presence, not proof of it. Keep the fresh-text-page readback (spike 05).

### 4.2 Line breaking

- **Greedy, from the edit point, with convergence.** Keep every line before the edited line
  byte-for-byte (original objects, original kerning). Re-break from the edited line's start
  with first-fit. Stop as soon as a new line ends at the same word as an original line and the
  remaining input is unchanged: from there on, reuse the original lines, shifted vertically if
  the line count changed. A typo fix therefore touches one or two lines, which is the single
  biggest factor in "it looks as if I made it". Word is generally understood to break
  greedily (not documented), so greedy is likely to match its output.
- **Knuth–Plass** ([Knuth & Plass 1981](https://onlinelibrary.wiley.com/doi/abs/10.1002/spe.4380111102))
  only for paragraphs detected as LaTeX-like (justified, hyphenated). Even then it re-optimises
  the whole paragraph, so earlier lines can move. Offer it only when the edit already changes
  every line.
- **Libraries** (npm, 2026-10-03, all MIT unless noted): `linebreak` 1.1.0 (UAX #14 break
  opportunities); `tex-linebreak` 0.9.0 (Knuth–Plass with pluggable measurement,
  [repo](https://github.com/robertknight/tex-linebreak)); `hyphenopoly` 6.1.0 (maintained);
  `hypher` 0.2.5 (BSD-3, unmaintained since 2016). npm `typeset` 0.3.5 is Typeset.js, not Bram
  Stein's Knuth–Plass library. A greedy breaker on top of `linebreak` is about 100 lines.

### 4.3 Spacing, justification, kerning

- **Word spacing.** `Tw` applies only to the single-byte code 32, so it does nothing for
  Identity-H fonts. Justify with `TJ` offsets at spaces, or with one positioned run per word as
  Word often does. Preserve the original `Tc` and `Tz`.
- **Justification.** Distribute the slack only over inter-word gaps. Cap stretch at 1.5 × the
  natural space; beyond that, try hyphenation, and if it is still too loose, leave the line
  ragged and flag it. The paragraph's last line stays natural.
- **Kerning.** Subsets usually lack `kern` and `GPOS`. Harvest instead: for every adjacent pair
  inside a word in the original paragraph's `TJ` arrays, record the offset, and re-apply it
  when the pair recurs. Where the full font is available (§4.6), read its kerning with fontkit.
  Kerning is off in Word's default settings, so most Word PDFs have none to preserve.
- **Ligatures.** If the subset has `fi`/`fl` glyphs (ToUnicode maps them to two characters),
  substitute them back when the typed text contains those pairs. Otherwise a retyped
  "office" looks different from the same word on untouched lines.

### 4.4 Hyphenation

Rejoin line-end hyphens on input (hyphen glyph at the line end, lowercase start on the next
line: PyMuPDF's dehyphenate rule). Hyphenate on output only when the original paragraph was
hyphenated, using the document language (`/Lang` on the structure element or catalogue, else
the UI language) with Hyphenopoly. The hyphen glyph may itself be missing from the subset
when the original never broke a word; check it like any other glyph.

### 4.5 Writing back

One new text object per output line, created exactly as in the Tier A split: same `FPDF_FONT`,
size, matrix, colour, render mode, and charcodes via `FPDFText_SetCharcodes` (never
`SetText`). Style runs (bold or italic words, link colour) are separate objects on the same
baseline. Remove the replaced lines' objects, keep untouched lines as they are, register fresh
MCIDs under the original `/P`, verify with a fresh text page, then call `GenerateContent`
once per page. Then move or resize `Link` annotations and markup `QuadPoints` that covered
moved words: Tier B already needs this, and Tier C reuses it (§5).

### 4.6 Missing glyphs

| Option | Fidelity | Notes |
|---|---|---|
| Refuse the character, honestly | Exact, but blocks the edit | Acrobat's stance for fonts it cannot edit |
| Extend the subset from the **full font** (Local Font Access on Chromium 103+, or a font file the user provides) | Exact | `queryLocalFonts()` plus `FontData.blob()` ([Chrome](https://developer.chrome.com/docs/capabilities/web-apis/local-fonts)); not in Firefox or Safari. Re-embedding the whole font changes glyph IDs: embed a *new* subset of the full font for the edited lines only (font name matched, outlines verified identical on shared glyphs), not a patched original |
| Per-glyph fallback to a bundled face (Inter, JetBrains Mono, Noto Serif, Noto Sans), size-matched on x-height | Visible patch on those glyphs only | Like browser font fallback; the honesty badge names the face |
| Whole-paragraph substitute | Consistent but visibly different | Acrobat's behaviour when the font is not installed (Minion Pro fallback); the right choice when many glyphs are missing |

**Recommendation.** Per edit, try the original codes. If any glyph is missing, offer, in this
order: the full font (local or uploaded), per-glyph fallback when ≤ 3 distinct glyphs are
missing, or a whole-paragraph substitute. Never insert a missing glyph silently.

## 5. The overflow problem

| Option | Effect | Use |
|---|---|---|
| (a) Grow the box and push the following blocks on the same page down into whitespace | Looks like Word, locally | Tier C. Only when every pushed block stays above the next obstacle (footer band, figure, page bottom minus margin) |
| (b) Tighten slightly | Invisible when small | Letter spacing first (as Infix does), then leading −5 %, then size −0.5 pt. Floor: 95 % leading, 97 % size; beyond that the change is visible next to the untouched paragraphs |
| (c) Overflow with a warning | Honest, may overlap | Always available; the overlap is drawn in the editor, and the user can still commit |
| (d) Move the overflow to the next page | Breaks headers, footers, footnotes and figures | Not offered (§1.3) |

**Tiered policy.**
1. If the paragraph got shorter or keeps its line count: commit. When it gets shorter, Tier C
   can pull the following blocks up, but leaving a gap is the safer default.
2. If it grew and the gap below is enough (gap ≥ added height + the original inter-paragraph
   space): expand into the gap with no other change.
3. Otherwise, if (b) within its floors fits it: apply and say "spacing tightened by 3 %".
4. Otherwise, with Tier C and room further down the page: show a preview of the push-down and
   commit on confirmation.
5. Otherwise: overflow with a visible warning and the overlap highlighted; suggest shortening.

**Push-down mechanics (Tier C).** Segment the page into blocks: paragraphs, images, path
groups (ruling lines and boxes belong to the block they enclose), annotations and form fields.
Mark *fixed* bands: the top and bottom 8 % of the page when the same text recurs on other pages
at the same position (headers and footers), plus anything the user pins. Blocks in the same
column below the edited paragraph shift by Δy, applied as a translation on their text, image
and path objects. Link rectangles, markup `QuadPoints` and widget rectangles move with them.
Refuse when a block straddles columns, or when Δy would push any block into a fixed band.

## 6. The WYSIWYG overlay

| Approach | Fidelity | Cost |
|---|---|---|
| DOM `contenteditable` with the embedded font via `FontFace` | High for TrueType that survives the sanitiser; caret, selection, IME and accessibility come for free | Subsets often lack the `cmap`, `OS/2`, `name` or `post` tables the browser's OpenType Sanitiser requires; bare CFF (`FontFile3`) must be wrapped and Type1 converted. fontkit 2.0.12 parses only TTF, WOFF, WOFF2, TTC and DFont, so it cannot help. pdf.js does this repair (`createCmapTable`, `createOS2Table`, `Type1Font` in [fonts.js](https://github.com/mozilla/pdf.js/blob/master/src/core/fonts.js)) but only inside its worker. Type3 is impossible |
| **Canvas from PDFium glyph paths**, own caret and selection, input through a hidden `textarea` (or EditContext, Chromium only) | **Exact shapes at exact positions**: the same layout code produces the overlay and the commit | Caret, selection, IME composition, clipboard and screen-reader mirror must be built; glyph paths are cached per code (`FPDFFont_GetGlyphPath`) |
| Re-render through PDFium on every keystroke | Ground truth | Worker round trip plus `GenerateContent` (1–2 ms, spike 05) plus a clipped render: tens of ms per keystroke, fine when idle and too slow while typing |

**Recommendation.** Canvas glyph-path overlay while typing, at device pixel ratio, with
baselines from the layout engine. After 300 ms idle, a PDFium "proof" render of the paragraph
replaces the overlay pixels, so what the user sees settling is what will be saved. If glyph
paths are unavailable, fall back to the DOM editor in the substitute face, with the badge
saying so.

**Visual conventions** (Acrobat, PDF Expert): in edit mode every block has a thin outline;
click places a caret where clicked; the active block gets a blue box with side handles for its
width, and a side panel shows font, size and colour. Recto adds the honesty badge and
Split/Join on the box.

## 7. Verdict and tiers for Recto

### 7.1 Tiers

- **Tier A (done).** Single line, verified same font or bundled substitute.
- **Tier B.** Everything in §§3–4 and §6, with overflow policy steps 1–3 and 5 (§5); one
  history entry per committed paragraph; undo by replay.
- **Tier C.** §5 push-down and pull-up, with annotations and links moved and a preview.
- **Tier D.** Cross-page reflow, not feasible. *For the owner:* "A PDF is a set of finished
  pages, like a printed book. Recto can rewrite a paragraph and even make room on the same page,
  but it cannot make text spill onto the next page the way Word does. The file no longer knows
  which text is a header, a footnote or a page number, or where a figure is allowed to go.
  Pushing text across pages would scramble those, and no PDF editor does it reliably. For
  changes that big, edit the original document and export a new PDF."

### 7.2 Effort (one experienced engineer, Tier A code reused)

| Work item | Tier B | Tier C |
|---|---|---|
| Paragraph detection (tags + geometry + split/join) and corpus labelling | 2–3 wk | — |
| Layout engine: style runs, greedy + convergence, justification, kerning harvest, ligatures, hyphenation | 3–4 wk | — |
| Write-back: multi-line split, MCIDs, link and markup updates, verification | 1.5–2 wk | — |
| Canvas overlay editor (caret, selection, IME, clipboard, a11y mirror, proof render) | 3–4 wk | — |
| Missing-glyph flows (Local Font Access, upload, per-glyph fallback) | 1 wk | — |
| Page segmentation, fixed bands, object translation, preview | — | 3–4 wk |
| Tests: golden renders on Word, LaTeX, Chrome and InDesign fixtures | included | 1–2 wk |
| **Total** | **10–14 wk** | **4–6 wk** |

### 7.3 Risks

1. **Wrong paragraph guesses** on untagged multi-column or list pages: outline first,
   Split/Join, refuse when unsure.
2. **Visual drift** in re-typeset lines (kerning, justification): convergence limits it to
   edited lines; golden pixel tests.
3. **Missing glyphs**, the commonest blocker for "no font worries": the full font is reachable
   only through Local Font Access (Chromium) or upload.
4. **Page regeneration**: `GenerateContent` rewrites the whole page (spike 05).
5. **Tags and reading order**: new MCIDs and `/ParentTree` entries; verified with PDFium only.
6. **Annotations anchored to text** misalign unless moved with it.
7. **Signed documents**: any edit invalidates signatures; warn on entering edit mode.
8. **Canvas editor accessibility and IME**: start LTR and horizontal only.
9. **Private EmbedPDF internals** (`PdfiumNative.cache`), as in Tier A: pin and canary.

### 7.4 What to tell users

In the editor's info popover and the help page:

> "Recto rewraps the text inside this paragraph using the paragraph's own font, size, colour
> and spacing. Lines you did not change keep their exact spacing, and move up or down only if
> the paragraph gains or loses a line. Recto never moves text
> to another page, and it moves other content on this page only when you allow it: a PDF
> stores finished pages, not a flowing document. If you type a character that the font in
> this file does not contain, Recto shows it in a different font and tells you which one."

When a substitution happened, the badge adds: "Some characters use Noto Serif because the
original font in this file does not include them."
