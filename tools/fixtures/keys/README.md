# Test-only signing keys

**These private keys are public test data. They protect nothing, are trusted by
nothing, and must never be used to sign anything outside this repository's test
corpus.**

| File | Key | Used for |
| --- | --- | --- |
| `root-ca.key.pem` | RSA-2048, PKCS#8 | self-signed "pdf-editor Test Root CA" |
| `intermediate-ca.key.pem` | RSA-2048, PKCS#8 | "pdf-editor Test Intermediate CA", issued by the root |
| `signer-rsa.key.pem` | RSA-2048, PKCS#8 | "pdf-editor Test Signer", issued by the intermediate |
| `signer-p256.key.pem` | EC P-256, PKCS#8 | "pdf-editor Test Signer P-256", issued by the intermediate |

All subjects carry `O=pdf-editor test PKI (not trusted)`.

- The keys were generated once (2026-09-28) with
  `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048` (and
  `-algorithm EC -pkeyopt ec_paramgen_curve:P-256`) and committed so that the
  corpus is reproducible. Nothing regenerates them.
- `tools/fixtures/lib/pki.ts` builds the X.509 certificates from these keys at
  generation time (fixed serials, validity 2023-01-01 to 2036/2040/2045, fixed
  extensions; every certificate is signed by an RSA key) and signs the CMS of the
  signed fixtures with the RSA signer. RSASSA-PKCS1-v1_5 is deterministic, so
  certificates and signatures are byte-identical on every run. ECDSA is not, so no
  fixture is signed with the P-256 key. Node's `crypto` does all the work;
  OpenSSL is needed neither to generate nor to test.
- The generator writes the certificates, copies of the two signer keys and
  PKCS#12 files (password `test-only`; salts and IVs derived from the file name by
  `lib/p12.ts`) to `test/fixtures/pki/` for tests.
- Replacing a key changes every certificate and signed fixture: rerun
  `pnpm --filter @pdf-editor/fixtures-tool generate` and commit the results.
