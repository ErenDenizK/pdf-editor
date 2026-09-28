---
title: "Research: signing spike S2 (Cantoo incremental writer, PAdES-B, PKCS#12) for M5 §3"
date: 2026-09-28
status: snapshot
---

> Spike S2 of `docs/specs/recognize-and-compare.md` §8.1, run on 2026-09-28 with
> `@cantoo/pdf-lib` 2.11.1, `pkijs` 3.4.1 / `asn1js` 3.0.10, `@embedpdf/pdfium` 2.15.1,
> `pdfjs-dist` 6.3.289, Node 22.22.2, headless Chromium 141 and OpenSSL 3.0.13. Evidence is the
> workspace package `tools/signing-spike/` (`pnpm --filter @pdf-editor/signing-spike spike`:
> 7 Node tests, then 1 Chromium test; 21 s wall time here). The package writes its tables and the
> openssl inputs to `tools/signing-spike/test-results/`, which git ignores. Each run creates a
> fresh throwaway test PKI with `openssl`. Only numbers from those runs appear below.
> Not available on this machine: poppler `pdfsig`, the `qpdf` CLI and `mutool`, so the spec's
> `pdfsig` and `qpdf --check` cross-checks were **not run**.

# Signing spike: sign on Cantoo, with five rules

## 0. Decision

**The Cantoo writer passes, so we sign on Cantoo (spec §3.2 rule) and signing stays in M5.**
All 60 appended sections (30 committed fixtures × 2 commits) keep the original bytes as an
identical prefix. None has a wrong xref offset. PDFium and pdf-lib open every output, and
pdf.js opens all but one (the two-commit case of defect D2, which we avoid). Our
validator and `openssl cms -verify` accept all 30 signatures, and the same holds for all 25
signed export outputs. We do not need our own writer, and the spike did not build one.

The spike did find three Cantoo defects and two traps. Each one has a simple workaround in
our own code (§3), and W3 must follow all five as rules.

## 1. Method

- `src/pdf-edits.ts` makes the incremental changes: an empty `/Sig` widget; an approval
  placeholder (`/Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached`, `/M`, a fixed-width
  `/ByteRange [0 9999999999 …]`, 16 KB of zero-filled `/Contents`, `/SigFlags 3`, and no
  `/Perms`, `/Reference` or DocMDP); a text annotation; a `drawText` edit. Each goes through
  `load(bytes, { forIncrementalUpdate: true })` + `commit()`.
- `src/sign.ts`: finds the placeholder **only in the appended section** and patches
  `/ByteRange` in place (same width, space-padded). It hashes the ranges with SHA-256, then
  `src/cms.ts` builds the CMS: pkijs SignedData with detached content, the signed attributes
  contentType, messageDigest and signingCertificateV2 sorted as DER, and the chain as
  certificates. The DER hex goes into the reserve; if it does not fit, the call fails.
- `src/p12.ts` handles PKCS#12 with pkijs and imports the key with `importKey('pkcs8', …,
  false, ['sign'])`. `src/validate.ts` is the validator prototype, the seed of the
  signature validator (§8.3 gives it to W3). `src/xref.ts` is our own xref reader: it walks
  the `/Prev` chain and checks every offset in use; it does not use pdf-lib.
- Cross-checks on each output: pdf-lib plain reload; raw PDFium (`FPDF_LoadMemDocument`,
  `FPDF_DocumentHasValidCrossReferenceTable`, `FPDF_GetTrailerEnds`, `FPDFSignatureObj_*`);
  pdf.js `getAnnotations`; `openssl cms -verify -binary -inform DER -content <ranges>
  -CAfile root.crt -purpose any`; pkijs' own `SignedData.verify`.

## 2. Q1: incremental writer, per corpus file

Each file got c1 (empty `/Sig` field), then c2 (the signature), as two commits on **one**
loaded document, with `useObjectStreams` set to match the source. The **Checks** column
covers four things for each section: identical prefix, `/Prev` = the previous `startxref`,
xref kind = the source's kind, and every offset in use correct. The last column signs the
**export output** instead: a full Cantoo save with object streams, which is what the
assembler writes and what the product will sign.

| File | Source xref | Checks c1 / c2 | Objs c1+c2 | pdf-lib reload | PDFium | pdf.js | Validator / openssl | Signed export |
|---|---|---|---|---|---|---|---|---|
| annotations | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1061 B |
| broken-xref | damaged¹ | ok / ok | 4+4 | ok | **rebuilt**¹ | ok | intact / ok | intact, +1046 B |
| cropbox | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1074 B |
| encrypted-aes-128 | table | ok / ok | 4+4 | **garbled /T**² | ok, range ok | ok | intact / ok | refused² |
| encrypted-aes-256 | table | ok / ok | 4+4 | **empty /T**² | ok, range ok | ok | intact / ok | refused² |
| encrypted-owner-only-aes-256 | table | ok / ok | 4+4 | **empty /T**² | ok, range ok | ok | intact / ok | refused² |
| encrypted-rc4-128 | table | ok / ok | 4+4 | **garbled /T**² | ok, range ok | ok | intact / ok | refused² |
| encrypted-rc4-40 | table | ok / ok | 4+4 | **garbled /T**² | ok, range ok | ok | intact / ok | refused² |
| forms-a | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1226 B³ |
| forms-b | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1210 B³ |
| garbage-prefix | damaged¹ | ok / ok | 4+4 | ok | **rebuilt**¹ | ok | intact / ok | intact, +1046 B |
| images | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1019 B |
| many-pages | stream, 23 in ObjStm | ok / ok | 5+5 | ok | ok, range ok | **bad ObjStm**⁴ | intact / ok | intact, +889 B |
| metadata-xmp | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1164 B |
| mixed-sizes | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +998 B |
| outline-named-dests | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1100 B |
| page-labels | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1010 B |
| redact-annotations | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +978 B |
| redact-form-xobject | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +962 B |
| redact-images | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +985 B |
| redact-incremental | table, 2 revisions | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +934 B |
| redact-metadata | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1191 B |
| redact-text-runs | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +935 B |
| rotated-pages | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1063 B |
| simple-text | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1046 B |
| tagged | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +1066 B |
| text-edit-fonts | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +989 B |
| text-edit-rotated | table | ok / ok | 4+4 | ok | ok, range ok | ok | intact / ok | intact, +946 B |
| truncated | damaged¹ | **no /Prev**¹ / ok | 4+4 | **no fields**¹ | ok, range ok | ok | intact / ok | intact, +957 B |
| xfa-stub | table | ok / ok | 4+4 | ok (`/XFA` kept) | ok, range ok | ok | intact / ok | intact, +1233 B³ |

¹ Damaged fixtures. Cantoo copies `/Prev` from the source's `startxref` value without
checking it. For broken-xref and garbage-prefix that value is wrong, so PDFium rebuilds the
xref, as it already did for the source. truncated has no `startxref`, so c1 gets no `/Prev`
at all. Signing the full-save export instead works on all three (last column).
² Loaded with the owner password. The new `/T` strings are written **in plaintext** into an
encrypted file, so they reload as garbage or empty. This confirms that the spec refuses
encrypted outputs.
³ The export's `/AcroForm` dictionary sits inside an object stream. The increment rewrites
it correctly (1 of the 6 objects written was compressed in the source).
⁴ Defect D2 (§3). The `many-pages` source keeps 23 objects in object streams; none of the
objects we touched was among them.

Objects written: c1 writes the catalog (an unchanged rewrite forced by `takeSnapshot`), the
page, the widget and the AcroForm. c2 writes the page, the AcroForm, `/Sig` and the widget.
Bytes added: c1 639–979; c2 785–1124 plus the 32 768-byte hex reserve. PDFium reports our
`/ByteRange` exactly in all 30 files. `FPDF_GetSignatureCount` also counts the empty field
(2 per file; 1 in many-pages because of D2), which is the M4 pairing bug the spec already
fixes by pairing on `/V`.

## 3. Q1 findings: Cantoo defects and traps, each with its workaround

- **D1: the default xref kind ignores the source.** When `useObjectStreams` is not passed,
  `saveIncremental` writes an xref stream for any header ≥ 1.5. Every corpus file has a 1.7
  header, so 29 of 30 got a stream appended to a classic table. **Rule: always pass
  `useObjectStreams: sourceKind === 'stream'`.** The stream writer keeps `/Type /Sig`
  dictionaries out of object streams, so the placeholder stays patchable in the raw bytes.
  Spec §3.2 says "commit without object streams". Our own export outputs use xref streams,
  and appending a stream section to them passed every check here. So: match the source.
- **D2: two `commit()` calls on one document reuse object numbers when object streams are
  on.** `PDFStreamWriter` hands its temporary ObjStm and xref-stream numbers back after each
  save. The next commit then reuses them: rev 3 redefines object 830 as the `/Sig`
  dictionary, while rev 2 still says objects 828 and 829 live in ObjStm 830. pdf.js then
  fails with "bad ObjStm stream". PDFium opens the file but silently loses widget 828 (1
  signature instead of 2). Reloading between commits works, and so do classic tables
  (`test-results/commits.md`). **Rule: one `commit()` per `load`.** This is an upstream bug
  worth reporting.
- **D3: the high-level page API edits page content.** `PDFPageLeaf.addAnnot` runs
  `normalize()`. That wraps `/Contents` in new `q`/`Q` streams and copies inherited
  `/Resources` onto the page. With `addAnnot`, our classifier marks the c1+c2 revisions as
  `content` in all 30 files. With the low-level path it sees only `signature` in 29 (the
  exception is truncated, whose source revision cannot be parsed). A second signature added
  with `addAnnot` turns the first one into **Changed after signing [content, signature]**
  (§6). **Rule: in the signing path, append to `/Annots` and `/Fields` with low-level
  dictionary operations only** (`appendAnnot`).
- **T1: nothing follows the final `%%EOF`.** `FPDF_GetTrailerEnds` counts a revision only
  when an end-of-line follows `%%EOF`, so it skips the last revision of every Cantoo output
  (for example `[2878]` instead of `[2878, 36624]`). **Rule: append `\n` before patching the
  byte range.** The range then includes it and PDFium reports both ends. The validator must
  accept a revision end both with and without an EOL (the prototype does).
- **T2: damaged or encrypted inputs.** See notes ¹ and ² in §2. **Rule: sign only the
  verified export output; refuse encrypted outputs.** The spec already says this.
- **Two consecutive commits (the question as asked):** classic table: yes. Xref stream: no
  on the same document (D2), yes after a reload.

## 4. Q2: PAdES-B signature, cross-checked

| Source | Key | Xref added | Validator | openssl `cms -verify` | Signed attrs (openssl) | pkijs verify | PDFium | CMS B | Added w/o reserve | ms (Node) |
|---|---|---|---|---|---|---|---|---|---|---|
| simple-text | RSA-2048 | table | intact, all checks pass | successful | contentType, messageDigest, signingCertificateV2 | yes | ETSI.CAdES.detached, range =, `/M` | 3376 | 997 | 30 |
| simple-text | ECDSA P-256 | table | intact, all pass | successful | same | yes | same | 2987 | 997 | 16 |
| many-pages | RSA-2048 | stream | intact, all pass | successful | same | yes | same | 3376 | 908 | 115 |
| many-pages | ECDSA P-256 | stream | intact, all pass | successful | same | yes | same | 2987 | 908 | 54 |
| forms-b export | RSA-2048 | stream | intact, all pass | successful | same | yes | same | 3376 | 1229 | 15 |
| forms-b export | ECDSA P-256 | stream | intact, all pass | successful | same | yes | same | 2986 | 1229 | 11 |

pdf.js opens every output and lists the `Signature1` widget. The chain is root →
intermediate → leaf, and the prototype reports "complete to a root included in the file
(3 certificates; not trusted)". **SET OF order:** OpenSSL re-encodes the signed attributes
before it verifies, so they must be sorted as DER (`cms.ts`). **signingTime:** the signer
omits it; the claimed time is `/M`, which PDFium reports as
  `D:20260928100000Z`. If signingTime is added as a signed attribute, openssl and our
  validator still verify (Q4 table), so it is optional for us. The spec's "no signingTime"
  stands. We did not check the ETSI EN 319 142-1 text itself.

## 5. Q3: PKCS#12 with pkijs

| File (made with `openssl pkcs12 -export`) | `openssl pkcs12 -info` | pkijs 3.4.1 result |
|---|---|---|
| RSA, OpenSSL 3 default | MAC sha256 ×2048; certs and key PBES2/PBKDF2-HMAC-SHA256/AES-256-CBC ×2048 | ok, chain 3, non-extractable key, 21–83 ms |
| RSA, `-keypbe/-certpbe AES-256-CBC -macalg SHA256` (the Windows "AES256-SHA256" choice) | identical to the default | ok |
| ECDSA P-256, OpenSSL 3 default | as the default | ok (`ECDSA P-256`) |
| RSA, `-certpbe NONE` (certificates in plain Data) | key PBES2 only | ok |
| RSA, default, password `şifre-İĞ-ü` | as the default | ok (pkijs sends UTF-8 to PBKDF2 and BMPString to the MAC KDF) |
| RSA, `PBE-SHA1-3DES` for both, MAC SHA-1 | pbeWithSHA1And3-KeyTripleDES-CBC | **refused `legacy-encryption`** with re-export instructions |
| RSA, `-legacy` (RC2-40 certs, 3DES key) | pbeWithSHA1And40BitRC2-CBC | **refused `legacy-encryption`** |
| Default file, wrong password | – | refused `bad-password` (MAC check) |

For every key, `extractable === false` and `exportKey('pkcs8')` rejects, in Node and in
Chromium (page and worker). pkijs quirks W3 will meet: parsing rewrites implicit tags of the
parsed ASN.1 in place (parse a fresh copy to inspect an `EncryptedData` twice);
`PKCS8ShroudedKeyBag.parseInternalValues` is typed `protected` (the prototype calls the
public `EncryptedData.decrypt`, the same code); `parsedValue` and `sid` are typed `any`.
We had no real Windows export: the "Windows" row uses OpenSSL with the matching flags.

## 6. Q4: modification detection

| Scenario | Validator (prototype) | openssl over the range |
|---|---|---|
| Signed, then a text annotation (incremental) | intact-changed-later [annotations] | ok |
| The same, truncated at the signed revision ("View signed version") | intact | – |
| Signed, then `drawText` on page 1 (incremental) | changed-after-signing [content] | ok |
| Signed twice (RSA, then ECDSA in a new revision) | intact-changed-later [signature] / intact | ok / ok |
| Signed twice, the second via `PDFPageLeaf.addAnnot` (D3) | **changed-after-signing [content, signature]** / intact | – |
| 20 seeded 1-bit flips inside the ranges | broken ×20 (digest) | accepted 0/20 |
| `/ByteRange` shortened by one byte | broken (byte range) | – |
| 1 KB reserve with a 3-certificate chain | "CMS is 3376 bytes; only 1024 reserved" | – |

Workstream F's fixtures from an independent signer (untracked while this spike ran) give
the expected result each: signed-approval and signed-empty-field **intact**; signed-sha1
(`adbe.pkcs7.sha1`) **intact** with the digest noted as weak SHA-1; signed-tampered
**broken** (digest); signed-then-changed **changed-after-signing [content]**;
signed-then-modified **intact-changed-later [annotations]**; signed-twice
**intact-changed-later [signature] / intact**.

Coverage: `/ByteRange` must start at 0, its gap must be exactly `<hex>`, and it must end at a
revision end or at EOF. Every later section is parsed with our xref reader. Objects are
compared between the truncated revision and the full file (pdf-lib), so Cantoo's unchanged
catalog rewrites are ignored. The rest are classified as annotation (with its appearance
streams), signature widget or `/Sig`, AcroForm `/Fields` growth, page with only `/Annots`
changed, page `/Contents`, Info, or DSS. Spike shortcut: signatures are found by scanning
for `/ByteRange`; the product walks the field tree.

## 7. Q5: size, time, workers

- **Size:** the appended section without the reserve is 0.9–1.2 KB. The CMS is 3376 B
  (RSA-2048, 3 certificates) or 2987 B (P-256), so the 16 KB default reserve has 4.8×
  headroom. Suggested reserve: chain DER + 4 KB, rounded up to 4 KB, at least 8 KB.
- **Time** (medians of 5 in a Chromium page): PKCS#12 parse 10–22 ms; sign 3–7 ms for small
  files and 29–38 ms for many-pages (400 pages, mostly Cantoo's load and commit); validate
  7–12 ms. First run in a fresh module worker (cold): parse 43 ms, sign 73–76 ms, validate
  24–30 ms. Node takes 11–115 ms to sign.
- **Workers:** Chromium runs the whole pipeline in a dedicated **module** worker
  (`DedicatedWorkerGlobalScope`, secure context, `crypto.subtle` present). pkijs 3.4.1 sets
  its engine from `globalThis.crypto` on import ("webcrypto") in page, worker and Node, so
  no `setEngine` call or Buffer polyfill is needed. Nothing blocks the signature worker.
  Node differences: none in the code path; the spike copies Node `Buffer`s to exact
  `ArrayBuffer`s first. Not measured: Firefox and WebKit, and the worker's bundle size.
- **Vite 8 trap for tests:** `server.fs.deny` blocks `*.{crt,pem,key,p12,pfx,cer,der}` by
  default, and that also stops `commands.readFile` on `test/fixtures/pki`. The spike config
  re-allows `.p12`; W3 and F need the same.

## 8. Draft for ADR-0013 (signature validation semantics and signing)

**Validation ("valid" offline).** We never say "valid". A signature is **Intact** when all
four hold:
1. `/ByteRange` is `[0 b c d]`, the gap is exactly the `/Contents` hex string read from the
   raw bytes, and `c+d` is the file end;
2. the hash of those bytes equals `messageDigest` (for `adbe.pkcs7.sha1`, the encapsulated
   digest);
3. the CMS signature over the DER signed attributes verifies with the certificate named by
   `sid`;
4. for `ETSI.CAdES.detached`, `signingCertificateV2` hashes to that certificate.

Chain, validity (at `/M` and now) and key usage are reported as checks. They never change
the status, because there is no trust store: "complete to a root included in the file" is
the best chain outcome.

Statuses, by precedence:
- **Broken:** the byte range is malformed or does not end at a revision end, or the digest
  or signature does not match, or signingCertificateV2 does not match;
- **Cannot check:** the CMS is unreadable, or the algorithm or subfilter is unsupported;
- **Intact, changed later:** later revisions contain only form fill, annotations,
  signatures or DSS (unless DocMDP `/P` says otherwise);
- **Changed after signing:** any other later change, listed with its pages;
- **Intact:** otherwise.

Every status carries the fixed line "Checked on this device against the certificates in
the file. Signer identity, trust and revocation are not verified." SHA-1 is marked weak and
MD5 is Cannot check. Nothing is fetched.

**Signing scope (M5).** PAdES-B-B **approval** signatures only: no `/Perms`, `/Reference`
or DocMDP; certification is M6. RSA PKCS#1 v1.5 with SHA-256, or ECDSA P-256/P-384 with
SHA-256 (the spike exercised RSA-2048 and P-256 only). The signed attributes are
contentType, messageDigest and signingCertificateV2; the claimed time is `/M`. Signing is
the last export step, over verified export bytes: one `load(…, { forIncrementalUpdate:
true })` and **one** `commit({ useObjectStreams: <source kind> })`, low-level dictionary
edits only, `\n` after `%%EOF`, `/ByteRange` patched inside the appended section, the CMS
embedded or a failure if it does not fit. Before download, the validator must say Intact
over the whole file and PDFium must open it. The key is imported from a PBES2 PKCS#12 as a non-extractable WebCrypto key in a
terminating module worker. Refused: encrypted outputs, legacy 3DES/RC2 PKCS#12 (with
re-export instructions), certification signatures, timestamps and LTV.

## 9. Spec corrections proposed (`recognize-and-compare.md`)

- §3.2 "`commit` without object streams" should read "`commit` with `useObjectStreams`
  matching the source (explicitly), exactly once per load; append an EOL after `%%EOF`;
  never use `PDFPage`/`PDFPageLeaf` helpers in the signing path (D1–D3, T1)".
- §8.1 and §3.4 name `pdfsig` and `qpdf --check`. Neither ran here: pdfsig and the qpdf CLI
  are not installed. They stay CI-only checks (decision 8.7.3). W3's own validator,
  openssl, PDFium and pdf.js covered this spike.
- §3.4 fixtures: note the Vite 8 `fs.deny` default for `.p12` (§7).
