# ADR-0005: Virtual document model and history

**Status:** accepted · **Date:** 2026-09-26

## Context

Users open several PDFs and move pages between them. Rewriting PDF bytes on every drag
would be slow, would destroy undo, and would force early decisions about document-level
structures (outlines, forms, labels). Content edits (annotations, redaction) must live
inside an engine instance, while structural edits are pure data.

## Decision

- A `VirtualDocument` is an ordered list of `VirtualPage` references into immutable
  `SourceDocument`s (or blank/image pages) plus rotation delta, crop, declarative overlays,
  and document-level data (outline, labels, metadata, security). See ARCHITECTURE.md §3.
- Structural operations mutate only this model; bytes are produced once at export.
- Content operations are commands executed in the source's PDFium worker with inverse
  commands recorded; they join the same history stack.
- History is a persistent stack of workspace snapshots with structural sharing (Immer);
  coalescing for drags and property tweaks; capped by memory not count; persisted with
  source bytes to IndexedDB/OPFS for crash recovery.
- Export reconciles document-level structures explicitly (ARCHITECTURE.md §4) and
  verifies the output by re-parsing before download.
- Incremental (append-only) saving is used only for annotate/fill/sign of a single,
  unmodified source when signatures or revision history must be preserved; never after
  redaction, merge, or repair.

## Consequences

- Reorder/rotate/delete/merge are instant and fully undoable regardless of file size.
- Two representations must be kept coherent: the model and the engine edit logs. The
  export pipeline owns that sequencing; tests cover it with golden files.
- Duplicating a page that carries form widgets requires a policy (clone field with new
  name vs shared value); the model records the choice per page.

## Discussion summary

Reviewed with the project owner on 2026-09-26. The owner delegated the decision to the
project lead; the recommendation above was adopted as written.
