# ADR-0001: Project license

**Status:** accepted · **Date:** 2026-09-26

## Context

The engine choice and the license are one decision. MuPDF.js is the most complete single
PDF engine that runs in the browser (redaction, appearance-stream generation, encryption,
repair, journaling) but it is AGPL-3.0; serving its WASM from GitHub Pages is
distribution, so the whole application would have to be AGPL. Ghostscript WASM and
scribe.js are AGPL too. pdf.js and qpdf are Apache-2.0, PDFium is BSD/Apache-2.0,
pdf-lib forks and the EmbedPDF v2 packages are MIT, tesseract.js is Apache-2.0.

The two largest open-source PDF projects (Stirling-PDF, BentoPDF) both moved toward
AGPL-plus-commercial or dual licensing and both took community damage for it.

## Decision

License the project under **Apache-2.0** and restrict dependencies to permissive
licenses (MIT, BSD, Apache-2.0, ISC, MPL-2.0 for unmodified files). Ship a `NOTICE` file
listing bundled third-party components (PDFium, qpdf, tesseract, fonts, CMaps).

## Consequences

- MuPDF, Ghostscript, scribe.js, LibreOffice WASM are out. Their capabilities are covered
  by PDFium (EmbedPDF fork) + pdf-lib + qpdf, at the cost of more integration code
  (see ADR-0002).
- Anyone, including companies, may embed or fork the app without releasing changes. The
  project's protection against being repackaged as a paid product is trademark on the name
  and the fact that the hosted original is free.
- Apache-2.0 over MIT: explicit patent grant, matches pdf.js/qpdf/PDFium, and a `NOTICE`
  mechanism for attribution. Functionally equivalent for contributors.

## Alternatives considered

- **AGPL-3.0**: unlocks MuPDF.js (simpler engine story, best-in-class redaction and
  annotation appearance generation) and prevents closed forks. Rejected for now because it
  narrows adoption (many companies forbid AGPL in the browser) and because the permissive
  stack is demonstrably sufficient (Stirling-PDF v2/v3 and BentoPDF both converged on
  EmbedPDF/PDFium + pdf-lib + qpdf). Can be revisited if a feature is impossible without
  MuPDF; going MIT/Apache → AGPL is possible, the reverse is not.
- **MIT**: equivalent in practice; Apache-2.0 preferred for the patent clause.
- **Dual license / open core**: explicitly against the project's principles.

## Discussion summary

Reviewed with the project owner on 2026-09-26. The owner delegated the decision to the
project lead; the recommendation above was adopted as written.
