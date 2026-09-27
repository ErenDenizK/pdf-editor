# Spec: Document tools (M3)

**Status:** draft (2026-09-27) · **Milestone:** M3 · **Owner:** project lead

M3 turns the workspace into a complete everyday PDF tool: forms, page furniture (numbers,
headers, footers, watermarks, Bates), metadata, passwords and permissions, compression
with honest numbers, image export, and repair. Every tool is an action on the open
document, reachable from the command palette and a **Document** menu in the tab bar; none
opens a separate "tool page". Every result is previewable before export and undoable.

## 1. Forms (AcroForm)

- Widgets render through the engine; in Read mode with the Select tool, clicking a field
  focuses a native-feeling editor: text (single/multi-line, max length, comb), checkbox,
  radio group, combo/list box, push button (no JavaScript actions executed; a notice
  explains when a button has an action we do not run), signature field (read-only, shows
  signer name and date if present, "not validated" badge).
- Tab / Shift+Tab move between fields in document order; Enter commits; Esc reverts the
  field; values are engine edits in history ("Fill Name").
- A **Forms panel** (left rail) lists fields with values, required markers and page
  jump; "Clear all", "Highlight fields" toggle (translucent fill), "Flatten on export".
- Appearance regeneration on every value change (`regenerateWidgetAppearances`) so other
  viewers show the value; `/NeedAppearances` written false.
- XFA: on open, documents with `/XFA` show an honesty badge; if AcroForm widgets exist
  (XFA foreground) filling works via AcroForm and export strips `/XFA` with a notice; pure
  XFA documents show "This form uses XFA, which no browser engine can edit" and stay
  read-only.
- Field creation (text, checkbox, radio, dropdown, signature placeholder) is **M4**.

## 2. Page furniture (overlays)

All are declarative `OverlayOp`s on `VirtualPage` (already in the model), materialized at
export by the assembler, previewed live in Read and Arrange through a page overlay that
draws the same layout in CSS.

- **Page numbers**: template with tokens `{page} {pages} {label} {title} {date} {bates}`,
  presets ("1", "Page 1 of 10", "1 / 10", "- 1 -"), anchor (9 positions), margins, font
  (bundled Inter / JetBrains Mono / Noto Serif subsets, embedded), size, colour, opacity,
  start number and page range (e.g. skip the cover), odd/even mirroring for duplex.
- **Header / footer**: left, centre, right slots per edge, same tokens; date formats via
  `Intl.DateTimeFormat`.
- **Bates numbering**: prefix, zero-padded width, start, suffix; applied across a
  selection of documents in tab order with one continuous counter; the last number is
  remembered per prefix.
- **Watermark**: text or image; opacity, rotation (−90…90, preset 45), scale, tiling
  (gap x/y), behind or over content, page range; the assembler writes it as a Form
  XObject reused by every page. An optional "removable" mode writes a `/Watermark`
  annotation instead of content.
- Honesty: overlays respect `/Rotate` and `/CropBox`; the preview and the export share one
  placement function (`overlay-geometry.ts`) covered by tests at all rotations.

## 3. Metadata

Right panel **Info** becomes editable: Title, Author, Subject, Keywords, Creator,
Language (BCP-47 picker), creation date (read-only), custom Info keys (add/remove). A
"Strip metadata" action removes Info, XMP, embedded files, JavaScript, `/PieceInfo`,
thumbnails and regenerates `/ID`, with a checklist dialog showing what was found. Export
writes Info and a mirrored XMP packet (already implemented) and applies the policy.

## 4. Passwords and permissions

- **Open**: password prompt (exists). Owner-only encrypted files open without a prompt
  and show a badge "Restricted: printing/copying disallowed by the author" listing the
  permission bits; we honour nothing silently: the badge explains that this app can
  remove restrictions and that doing so is the user's responsibility.
- **Set password** dialog: user password (open), owner password (permissions),
  permission checkboxes (print, high-quality print, modify, copy, annotate, fill forms,
  accessibility, assemble), AES-256 only (RC4/AES-128 not offered), strength meter,
  "Show password". Applied at export; the export summary states the algorithm.
- **Remove password**: needs the user password (already needed to open) or, for
  owner-only files, a confirmation.
- Second engine path (qpdf, ADR-0008) used for encryption when the pdf-lib path reports
  an unsupported filter; qpdf is built from source in CI in this milestone.

## 5. Compression

Two-stage dialog with an **estimate before** and **actual after**:

1. **Lossless**: object streams, unused objects and resources removed, duplicate image
   and font streams de-duplicated by hash, Flate recompression (qpdf). Always safe.
2. **Images**: per-image analysis table (page, size, colour space, current encoding,
   effective DPI); presets Screen (96 dpi, q 60), E-book (150 dpi, q 75), Print (300 dpi,
   q 85), Custom; downsample with high-quality resampling, re-encode as JPEG (or keep PNG
   for images with alpha or few colours), skip CCITT/JBIG2/JPX and images already at or
   below the target; never re-encode a JPEG to a larger or equal size; SMask handled or
   the image skipped. The engine decodes through PDFium so exotic colour spaces work.
3. Result screen: before → after per page and total, list of skipped images and why,
   "Compare" toggle rendering the same page before/after at 200% side by side.

Honesty: if the estimated gain is under 3%, the dialog says so before running.

## 6. PDF to images

Export pages as PNG/JPEG/WebP at 72/150/300/600 dpi or custom, page range, background
(white/transparent for PNG), file naming template; multiple pages produce a ZIP built
in a worker (fflate); tiles are used above the canvas limits. Single page can be copied
to the clipboard.

## 7. Repair and diagnostics

- On open, `repaired` sources show a badge; "Save repaired copy" runs a full rewrite
  through qpdf and verifies.
- A **Diagnostics** panel (right rail, Info) lists: version, page count, encryption,
  linearized, tagged, form type, fonts (embedded/not, subset), images (count, DPI
  histogram), annotations count, attachments, JavaScript presence, structural warnings
  from the xref check. This is also the M4 redaction pre-check.

## 8. Export dialog growth

Sections: Output (filename, compatibility mode), Security (from §4), Annotations (flatten,
comments), Forms (flatten), Compression (apply preset), Metadata (policy). The summary
already lists reconciliation notes; add security algorithm, compression delta, flattening
counts.

## 9. Tests

- Golden tests per overlay preset at four rotations and with a CropBox offset.
- Compression: fixtures with a Flate RGB image, a JPEG, a PNG with alpha, a CCITT scan
  (real-world file to be added under a permissive licence), asserting skip rules and
  size deltas; visual diff of before/after within a PSNR threshold.
- Encryption: round trips through PDFium and pdf-lib for each permission set.
- Forms: fill every field type in forms-a/forms-b, export, re-open, values and
  appearances present; XFA detection paths.

## 10. Out of scope

Field creation, redaction, text editing (M4); OCR, compare, signatures (M5); batch
recipes (M5).
