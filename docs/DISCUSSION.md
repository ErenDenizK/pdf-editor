# Open decisions

**Status:** living document. Items are ordered by how much downstream work they block.
Each item states the options, a recommendation, and what changes if the owner disagrees.
When an item is settled it moves into the relevant ADR and is struck from here.

## Settled on 2026-09-26

The owner delegated all open items to the project lead. Resolutions, recorded in the ADRs:

| Item | Resolution |
|---|---|
| 1. License | Apache-2.0 (ADR-0001) |
| 2. Rendering | PDFium only; pdf.js documented fallback (ADR-0002) |
| 3. Frontend | React 19 + React Compiler (ADR-0003) |
| 4. Name and domain | Working name `pdf-editor`; naming proposal due before M1 exit; custom domain before v1.0 |
| 5. v1.0 scope | After M3 (ROADMAP.md) |
| 6. Text editing | Tiers 1 and 2 in v1.x with honesty states; tier 3 research for v2 |
| 7. Browser floor | Chromium 125+, Firefox current and ESR, Safari 18+; desktop-first |
| 8. Theme | Dark only in v1; light theme v1.x |
| 9. UI languages | English and Turkish from M1 |
| 10. Headless primitives | Evaluate Radix Primitives vs Base UI in M0; ADR-0009 |
| 11. qpdf | Built from source in CI, integrated in M3 (ADR-0008) |
| 12. Analytics | Never, including opt-in; the privacy indicator is a guarantee |
| New: delivery targets | Web first; desktop edition only on defined triggers (ADR-0007) |

## Settled on 2026-09-27 (owner review after M3)

| Item | Resolution |
|---|---|
| 13. Cross-viewer annotation matrix | Manual testing in Acrobat/Preview/Edge is too laborious for one person; replaced by an automated matrix (our PDFium build + pdf.js, headless, in CI) with an optional five-minute manual spot check. See `docs/qa/annotations-matrix.md`. |
| 14. Note icons on rotated pages | Keep the spec behaviour (NoRotate: icon upright on `/Rotate` pages). The owner saw another viewer turn the icon; that viewer is the non-conformant one. Our overlay hit box is corrected to match the drawn icon. |
| 15. Rendering sharpness | Final page bitmaps render at the exact device scale (1:1 device pixels) instead of the nearest quarter-octave bucket; buckets stay for previews and thumbnails. |
| 16. M4 | Approved as specified (`docs/specs/redaction-and-text-editing.md`); started 2026-09-27 with two engine spikes (raw PDFium access for text editing, EmbedPDF redaction coverage). |
| 17. Design refinement pass | Owner direction: simplicity is right, but surfaces should be more translucent and a few effects look wrong. Scheduled as a dedicated pass after M4 (before M5), with a review of every effect against `docs/DESIGN.md`. |
| 18. Product name | No hurry; decided last, before the v1.0 tag at the earliest. |
| 19. M4 exit (2026-09-28) | Done after two independent reviews; 24 findings fixed with regression tests. Next: the design refinement pass (item 17), then M5. |
| 20. Design refinement pass (2026-09-28) | Done: a token scale for radii and borders, translucent glass for every floating surface (`--glass` with a measured contrast margin), the effects that looked wrong toned down or removed, `docs/DESIGN.md` §2/§3/§5/§7 and the screenshots updated. The owner is asked to look at the glass surfaces in real Chrome, Safari and Firefox; headless captures cannot show backdrop blur faithfully. |
| 21. M5 (2026-09-28) | Built as specified after two spikes (OCR offline, signing) and three ADRs. Two spec details changed on evidence: OCR quality thresholds are 90/80 (research 07) instead of 85/60, and the OCR files live under `ocr/tesseract-7.0.0/`. The batch OCR step is deferred to the review-fix round. The independent review is running; findings are fixed before the milestone is called done. |

## Open

### 9. Product name

Needed before M1 exit for the manifest, wordmark and tab title. Constraints: short,
pronounceable in English and Turkish, not "PDF-something-tools", trademark searchable. A
shortlist will be proposed as a separate note in `docs/design/`.

### 10. Headless primitive library

Evaluated in M0 with a menu, dialog, tooltip and popover; recorded as ADR-0009.
