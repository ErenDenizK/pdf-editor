# ADR-0015: Product name: Recto

**Status:** accepted · **Date:** 2026-10-01 · **Deciders:** project lead; confirmed by the owner on 2026-10-01

## Context

The app has shipped under the working name `pdf-editor`, the repository name, since M0.
`DISCUSSION.md` #9 and #18 left the product name open, and `docs/design/naming.md` kept a
shortlist. The owner's review after M5 (#23) asked for a name before the public beta and
left the choice between Quire and Recto to the project lead. A naming study (2026-10-01)
checked Quire, Recto, Kerf, Varak and Bifolio against products in the PDF and document
space, GitHub, npm, DNS, trademark search snippets, and English and Turkish readings. The
trademark offices (USPTO, EUIPO, TÜRKPATENT) could not be reached from the research
environment, so trademark findings rest on search snippets only.

Findings that decided it:

- **Quire** is a registered US trademark (2014) for a task-management SaaS that has run at
  quire.io since 2013. Getty's open-source publishing tool, which outputs PDF and EPUB, is
  also called Quire. Three GitHub PDF projects named Quire*PDF appeared in 2026, and
  `quirepdf.com` and `quirepdf.app` are registered. Heard aloud it is "choir", so it gets
  misspelled, and Turkish has no *q*.
- **Recto** has no PDF-editor namesake. Its collisions are in other categories: Recto
  Notes (a notes app), Recto AI Designer (text-to-design) and a small open-source iOS notes
  app. No RECTO software trademark turned up. `rectopdf.*` did not resolve on any TLD
  checked. The meaning fits: the recto is the page you see first.

## Decision

1. **The product name is Recto.** It is the display name everywhere a person reads the
   product's name: the window and tab title, the manifest `name` and `short_name`, the
   wordmark, the README heading, the about page, release titles and the in-app About.
2. **"Recto PDF" is the descriptor.** It is the domain stem (`rectopdf.app`, ADR-0016),
   the first words of the repository description, and the `og:site_name` and other page
   metadata where a search or a link preview needs context. It adds distinctiveness next to
   Recto Notes and Recto AI. In running text the product is "Recto".
3. **Storage names do not change.** Renaming them would orphan what users keep on their
   device. These stay as they are:
   - Cache Storage `pdf-editor-ocr`, `pdf-editor-wasm`, `pdf-editor-fonts`;
   - IndexedDB `pdf-editor-recipes` and the OPFS `recipes` folder;
   - localStorage keys `pdf-editor:*` (locale, UI state, viewer positions, author, Bates);
   - the recipe format identifier `pdf-editor-recipe` (ADR-0014), which shared files carry;
   - file-picker ids (`pdf-editor-open`, `pdf-editor-images`), which remember folders.
   The private workspace scope `@pdf-editor/*` also stays: it is never published, and a
   rename would touch every import for no user-visible gain.
4. **The rename happens once, in M7** (presentation milestone), in one pass over the places
   listed in `docs/specs/presentation.md` §7, after the owner confirms this ADR and the
   domain exists. Until then the app keeps `pdf-editor` in every string, so no build ships
   with half a rename.
5. **Trademark checks are the owner's step before announcing**: USPTO (classes 9 and 42),
   EUIPO and TÜRKPATENT, for RECTO in software. If a conflicting mark turns up, the
   fallback replaces Recto in the same pass.
6. **Fallback: Kerf.** It has no product in the document space, the bare npm name is free,
   it reads the same in English and Turkish, and `kerfpdf.*` did not resolve. Its costs:
   the word is obscure and search results are dominated by woodworking tools.

## Consequences

- `DISCUSSION.md` #9 and #18 close with this ADR; `docs/design/naming.md` records the
  decision and keeps the shortlist for history.
- Known costs, accepted: in Spanish and Portuguese "recto" also means straight, honest and
  the rectum; Turkish has the medical prefix "rekto-", and Turkish readers will say "rekto"
  and some will write "Rekto". For an English and Turkish audience the bookish sense
  dominates. Registering `rekto` variants is cheap if it matters later.
- The bare `.com`, `.app`, `.dev` and `.io` for "recto" are all registered, the GitHub login
  `recto` and the npm name `recto` are taken. None of these is needed: the domain is
  `rectopdf.app`, the repository is `ErenDenizK/recto`, and nothing is published to npm.
- Internal labels that only developers see (worker names in DevTools) are renamed in the
  same pass for consistency; the test PKI's "pdf-editor Test Signer" is fixture data and
  stays.

## Alternatives considered

- **Quire.** Rejected: live US trademark for task-management software, Getty's publishing
  tool of the same name, Quire*PDF projects on GitHub, the "choir" sound-alike.
- **Varak** (Ottoman word for a manuscript leaf). Rejected: a local document tool was
  called Varak until a rename on 2026-09-30, which is too close.
- **Bifolio.** Clean namespace, but long and pronounced differently in the two languages;
  second fallback after Kerf.
- **Octavo, Folia, Folio, Stet, Quarto, Vellum, Codex, Verso.** Eliminated in the first
  pass for direct collisions with PDF readers, annotation apps, document editors or
  publishers.
- **Keeping `pdf-editor`.** Rejected: generic, not ownable, and against the constraint in
  `naming.md` ("not PDF-something-tools").
