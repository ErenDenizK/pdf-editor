# ADR-0013: Signature validation semantics and PAdES-B signing

**Status:** accepted · **Date:** 2026-09-28

## Context

M5 adds digital signature validation and signing (`docs/specs/recognize-and-compare.md`
§3). The app runs offline in the browser with no trust store, no revocation access and no
timestamp authority, so "valid" in the desktop sense cannot be claimed. Spike S2
(`docs/research/08-signing-spike.md`) established that `@cantoo/pdf-lib` 2.11.1 writes
correct incremental updates on the whole corpus, that pkijs 3.4.1 with WebCrypto produces
PAdES-B signatures accepted by openssl, PDFium and pdf.js, and that a module worker can
run the whole pipeline.

## Decision

1. **Validation runs automatically on open**, in a signature worker, and never says
   "valid". The statuses are: **Intact** (the CMS verifies over its byte range and the
   range covers the whole file), **Intact, changed later** (verifies; later incremental
   sections add only annotations, form values or another signature), **Changed after
   signing** (verifies; later sections touch page content, resources or the catalog in
   other ways), **Broken** (digest or signature mismatch, or a byte range that does not
   end at a revision boundary), **Cannot check** (unsupported SubFilter, algorithm or
   damaged structure). Every status carries the fixed line: checked on this device
   against the certificates embedded in the file; signer identity, trust and revocation
   are not verified. SHA-1 signatures are flagged weak.
2. **Signing is PAdES-B (ETSI.CAdES.detached), approval signatures only**, as the last
   step of an export over the verified output bytes. The key comes from a local PKCS#12
   parsed with pkijs (PBES2 only; legacy 3DES/RC2 files are refused with re-export
   instructions), is imported non-extractable, nothing is stored, and the worker is
   terminated after signing. Refused in M5: encrypted outputs (the fork writes strings
   unencrypted in incremental sections), certification (DocMDP) signatures, timestamps
   and LTV (documented as needing a proxy).
3. **Writer rules** (from the spike, binding for the implementation): `useObjectStreams`
   always passed to match the source's xref kind; one `commit` per `load`; only
   low-level `/Annots` and `/Fields` edits (never `PDFPageLeaf.addAnnot`, which rewrites
   page content); a newline appended after `%%EOF` before the byte range is patched;
   damaged sources go through the full export save first; signed attributes sorted as
   DER requires.
4. **Certificates** are shown as facts (subject, issuer, validity dates, algorithms,
   chain as embedded) with no trust judgement. A CI-only cross-check with poppler
   `pdfsig` is allowed (never a package dependency; ADR-0001 governs shipped code).

## Consequences

- Users get an honest integrity check and a way to sign locally, with the limits stated
  where the status is shown; the export summary records the signature like any other step.
- The fixtures under `test/fixtures/signed-*.pdf` and the test PKI are the acceptance
  corpus: zero false Intact on the tampered file is a release gate.

## Alternatives considered

- **Own incremental writer.** Not needed: the fork's writer passed 60 appended sections.
- **`@signpdf` and node-forge.** Not used: the former assumes a different writer, the
  latter's licence is dual BSD-3/GPL and it is 1.6 MB for a decryptor we do not need.
- **Certification signatures in M5.** Deferred to M6; their DocMDP rules need their own
  validation model.

## Notes after review

- **Unreferenced objects in a later revision** (second engine review, finding 3). An object
  that no cross-reference section lists is listed as a change of kind `other` ("unreferenced
  object N in revision K") but does not by itself lower the status below "Intact, changed
  later": readers resolve objects through the xref and ignore it. It stays a structural change
  when its number is in use in any xref section of the file, or when it could carry content (a
  stream, a page, a catalog, an annotation, a form field, a signature, or raw text a scan could
  take for an object header, trailer or xref), because a reader that rebuilds a damaged xref
  may pick it up; that reconstruction risk is what the content-bearing rule covers. Bytes that
  do not parse as objects remain a structural change.
