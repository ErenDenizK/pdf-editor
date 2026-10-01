<!-- version: 1.0.0-beta.0 -->
<!-- Release notes template (ADR-0017 §3, docs/specs/presentation.md §5). In the release pull request, set the version above and rewrite Highlights and Known limitations by hand. release.yml refuses a template whose version does not match, fills the {{…}} fields (Added, Changed and Fixed from the CHANGELOGs) and drops every line that is a whole HTML comment. No emoji and no exclamation marks: tools/copy-check checks this file. -->

## Highlights

Recto is a PDF editor that runs entirely in your browser: nothing is uploaded, and it works
offline after one visit. This first public beta opens many PDFs on one light table, where
pages move between documents, and adds annotations, forms, redaction, text editing, OCR,
comparison and digital signatures in the same workspace. Every export is re-opened and
checked before it is offered for download. Recto is built and maintained by one person and
has not been audited by a third party; versions stay `1.0.0-beta.N` until the 1.0 exit
criteria in the roadmap pass.

## Added

{{added}}

## Changed

{{changed}}

## Fixed

{{fixed}}

## Known limitations

- No Office conversion and no PDF/A claims.
- Signatures are Intact, Intact but changed later, Changed after signing, Broken or Cannot
  check, never "valid"; signer identity, trust and revocation are not checked, and there is
  no long-term validation (LTV).
- Text is edited one line at a time; paragraphs do not reflow.
- Markdown export guesses the reading order and does not detect tables.
- OCR, compare and the signing download are tested end to end in Chromium only.
- About 1 GB per document is the design ceiling.

The known behaviours of each milestone are listed in the
[roadmap](https://github.com/ErenDenizK/recto/blob/main/docs/ROADMAP.md).

## Verify

- Built by [this workflow run]({{run_url}}) from commit `{{commit}}`.
- SHA-256 of `{{dist_zip}}`: `{{dist_sha256}}`
- Check the downloaded files with `sha256sum -c SHA256SUMS`.
- `{{dist_zip}}` is built for the root of a static host (`/`); see the README to self-host.
