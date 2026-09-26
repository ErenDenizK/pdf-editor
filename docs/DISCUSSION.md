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

## Open

### 9. Product name

Needed before M1 exit for the manifest, wordmark and tab title. Constraints: short,
pronounceable in English and Turkish, not "PDF-something-tools", trademark searchable. A
shortlist will be proposed as a separate note in `docs/design/`.

### 10. Headless primitive library

Evaluated in M0 with a menu, dialog, tooltip and popover; recorded as ADR-0009.
