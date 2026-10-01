# Product name: shortlist

**Status:** decided 2026-10-01: Recto (ADR-0015). Fallback: Kerf. The shortlist below was
drafted on 2026-09-26 and is kept for history; the rename itself happens in M7
(`docs/specs/presentation.md` §7).

Constraints: short, pronounceable in English and Turkish, not "PDF-something-tools",
plausible to trademark-search, available as a `.app` or `.dev` domain ideally, works as a
single glyph at 16 px.

| Candidate | Rationale | Risks to check |
|---|---|---|
| **Folio** | A leaf of a book; page-centric; calm. | An existing tiny OSS PDF editor uses "Folio" (research 02 §1c); name collision likely. |
| **Quire** | A gathering of sheets in bookbinding; obscure but precise; unique. | Pronunciation ("kwire") unfamiliar to some. |
| **Signet** | A seal; implies documents and trust. | Signet Bank / jewellery marks. |
| **Leaflet** | Pages as leaves; friendly. | Leaflet.js (maps) is huge. Avoid. |
| **Recto** | The front side of a page; typographic; distinctive. | Slightly technical. |
| **Plait** | Weaving pages together (merge). | Meaning not obvious. |
| **Bindery** | Where books are assembled; matches the light table metaphor. | Long. |
| **Sheaf** | A bundle of pages; short; merge metaphor. | Sheaf theory (math); minor. |
| **Collate** | Exactly what the light table does. | Generic verb; hard to own. |
| **Paperclip** | Universal "holds pages together"; playful, memorable. | Common word; many products. |

Lead's preference on 2026-09-26: **Recto** or **Quire** for distinctiveness, **Sheaf** for
plainness. The owner then left the choice between Quire and Recto to the project lead
(DISCUSSION #23).

## Collision research (2026-10-01)

Web, GitHub, npm and DNS checks; trademark findings come from search snippets only, because
the trademark offices could not be reached. Two lines per candidate.

- **Recto**: no PDF editor of that name; Recto Notes, Recto AI Designer and a small iOS notes
  app sit in other categories. No RECTO software mark found (unverified); `rectopdf.*` free.
- **Quire**: QUIRE registered at the USPTO (2014) for task-management SaaS (quire.io);
  Getty's Quire publishes PDF and EPUB; three Quire*PDF repos in 2026; "choir" sound-alike.
- **Kerf**: no product in the document space; woodworking cut-list apps and a database
  share the name. Bare npm name free; `kerfpdf.*` free; reads the same in Turkish.
- **Bifolio**: clean namespace (one hobby e-ink reader on GitHub); long, and pronounced
  differently in English and Turkish.
- **Varak**: a local document tool was named Varak until a rename on 2026-09-30; too close.
  Hungarian "várak" means castles.
- **Folio**: several PDF tools, including an open-source local editor. Ruled out.
- **Octavo, Folia, Stet, Quarto, Vellum, Codex, Verso**: direct collisions with PDF readers,
  annotation apps, document editors or publishers. Ruled out in the first pass.
- **Signet, Leaflet, Plait, Bindery, Sheaf, Collate, Paperclip**: not searched again; the
  shortlist's own risks stand.

Every short bare domain in this vocabulary is registered; the domain is a compound such as
`rectopdf.app` (ADR-0016). Storage names (`pdf-editor-*` caches, the recipes database,
`pdf-editor:*` keys) keep the old name so users keep offline packs and recipes.
