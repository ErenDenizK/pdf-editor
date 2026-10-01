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
| 22. M5 exit (2026-09-28) | Done. The reviews found two blockers worth the exercise: a crafted incremental update could redefine a signed page while the report said "Intact but changed later" (later revisions are now read through the xref chain, ambiguous entries count as changes, and the signed pages are compared visually), and an OCR run could write back words a redaction removed while it ran (pages that changed under a run are recognised again). Also fixed: document timestamps shown as Broken, a Markdown ZIP that failed west of Greenwich, OCR hit boxes off by up to 5 pt, stale comparisons after undo, batch outputs of signed files. Next: the owner merges `develop` into `main` and tags v1.2.0; M6 planning. |
| 23. Owner review after M5 (2026-10-01) | Direction: the site is both a tool and a portfolio piece, so presentation and experience must be first-rate. Experience: too complicated, the left tabs carry too much detail, a home page for several PDFs and merging of opened files are missing, the pen opens a menu after every stroke and should write like Notability with a lasso to edit afterwards, glass and floating chrome should be more contrasty, elegant and alive, the feel of use (pick from a bottom menu, click to edit) should be designed. Name: Quire or Recto, our choice. Presentation: a professional GitHub page with images and clips, a landing page at our discretion, a naming structure for `erendenizk.github.io/<repo>` sites, and a versioning scheme that never says 1.0 before it is earned. Method: evaluate everything up front, then plan. Response: an experience audit with 67 screenshots, three research reports, `docs/specs/experience-redesign.md`, `docs/specs/presentation.md`, ADR-0015/0016/0017, and milestones M6 (Experience) and M7 (Presentation and public beta) in the roadmap. Decisions taken: Recto; domain-first migration; `1.0.0-beta.0` as the first public release; M1–M5 relabelled internal. Awaiting the owner: the structural layout change (four-tab navigator, task-grouped bar), the domain purchase, the trademark check, light-theme timing. |
| 24. Owner answers (2026-10-01) | GitHub Pages only for now, no domain; links may change freely since there are no active users (the move to `/recto/` happens in M7 with the redirect folder). The address questions are answered in ADR-0016's discussion summary: `ErenDenizK.github.io` must carry that exact name to serve the root, every other repository serves at `/<repository>/`, and what lives there is whatever the repository deploys, for Recto the app with `/about/` beside it. Design direction approved; the shape of the group menu left to the lead: an in-place morph of the capsule bar, no radial menu, drawer or sheet (spec §5.2, decision 13). Light theme moved to M8. M6 starts. |
| 25. M6 exit (2026-10-01) | Done in one day of agent work: Home, four-tab navigator, task-grouped capsule bar, natural pen (presets, bursts, lasso, pressure widths written into the file), merge discoverability, visual refresh, accessibility pass. The independent review found no blocker; its three major findings (a lasso width change drifted strokes, a width change on a plain selection did not show, redaction marks selected themselves) and the experience gaps (Open-files path, Files tab, glass over a white page, bursts across lines, Draw not arming the pen) were fixed the same day. Owner to try the burst defaults on a real tablet. Next: M7 (rename to Recto at `/recto/`, README and media, about page, `1.0.0-beta.0`). |

## Open

### 9. Product name

Settled: **Recto** (ADR-0015, confirmed by the owner on 2026-10-01; this also closes #18).
The shortlist and the study are in `docs/design/naming.md`; the addresses are in ADR-0016.
The owner's trademark check before announcing remains (ADR-0015 decision 5).

### 10. Headless primitive library

Evaluated in M0 with a menu, dialog, tooltip and popover; recorded as ADR-0009.
