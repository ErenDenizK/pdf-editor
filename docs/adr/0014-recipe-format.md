# ADR-0014: Batch recipe file format

**Status:** accepted · **Date:** 2026-09-28

## Context

M5's batch feature (`docs/specs/recognize-and-compare.md` §5) applies an ordered list of
existing operations to many files. Recipes must be saveable, shareable and stable across
versions, and must never carry secrets.

## Decision

1. A recipe is a JSON document `{ "format": "pdf-editor-recipe", "version": 1, "name",
   "description?", "steps": [...] }`, where every step is `{ "kind", "options" }` and the
   kinds are exactly the operations the app already exposes (rotate, page numbers,
   header/footer, watermark, compress preset, metadata strip or set, password and
   permissions, page size, crop, OCR, export options). Unknown kinds fail
   validation with the step index; unknown option keys are rejected, not ignored.
2. **No secrets are ever serialized.** A password step stores only that a password is
   required; the value is asked for at run time and held in memory. A property test over
   generated recipes asserts that no serialized recipe contains any password field.
   Redaction is deliberately not a recipe step: it needs a human review per document.
3. Recipes are stored in OPFS under the app's origin, listed with name, step count and
   last used; import and export are plain files; built-in recipes ship as constants and
   are not editable (users duplicate them).
4. **Versioning:** the `version` integer increases only for incompatible changes; the
   reader keeps a migration for every past version, and a recipe newer than the reader
   is refused with a message naming the app version needed.
5. Each file runs through the normal export pipeline with verification; files never
   become tabs; the run report lists per-file outcomes and every honesty notice the steps
   produced, and the outputs are delivered as a ZIP or one by one.

## Consequences

- Recipes are portable and reviewable text; the format is documented in the spec and
  covered by schema tests.
- Any future operation that wants to be batchable must expose a serializable options
  shape and a validator.

## Alternatives considered

- **Storing recipes in localStorage.** Rejected: size limits and no file semantics.
- **Allowing passwords in recipes for convenience.** Rejected: the privacy indicator is a
  guarantee (DISCUSSION #12), and shared recipe files would leak them.
