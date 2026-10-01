# Architecture Decision Records

Each significant, hard-to-reverse decision gets one file: `NNNN-short-title.md`.
Format: Context → Decision → Consequences → Alternatives considered. Status is one of
`proposed`, `accepted`, `superseded by NNNN`, `deprecated`. A proposed ADR becomes accepted
only after discussion with the project owner; the discussion summary is appended.

| # | Title | Status |
|---|---|---|
| 0001 | Project license | accepted |
| 0002 | PDF engine stack | accepted |
| 0003 | Frontend stack | accepted |
| 0004 | Static hosting, workers and no cross-origin isolation | accepted |
| 0005 | Virtual document model and history | accepted |
| 0006 | Branching, versioning and commit conventions | accepted |
| 0007 | Delivery targets: web first, desktop as escalation path | accepted |
| 0008 | qpdf integration deferred to M3 and built from source | accepted |
| 0009 | Headless accessibility primitives: Base UI | accepted |
| 0010 | i18n with Paraglide JS and offline PWA with vite-plugin-pwa | accepted |
| 0011 | Engine hosting for content editing: own PDFium worker, raw access | accepted |
| 0012 | OCR engine hosting and language packs | accepted |
| 0013 | Signature validation semantics and PAdES-B signing | accepted |
| 0014 | Batch recipe file format | accepted |
| 0015 | Product name: Recto | accepted |
| 0016 | Addresses: portfolio root, project paths, custom domain and migration | accepted (GitHub Pages only for now) |
| 0017 | Versioning and public releases: `1.0.0-beta.N` first | accepted |
| 0018 | Variable-width ink as a standard Ink annotation with our appearance | accepted |
