# Vision

**Status:** draft for discussion (2026-09-26)

## One sentence

Recto (ADR-0015) is a free, open-source PDF editor that runs entirely in the browser,
never uploads a file, and treats PDF editing as a single coherent document workspace
rather than a grid of disconnected "tools".

## The thesis

The PDF tooling market is split into two camps, and both fail users in predictable ways
(see `research/02-market-and-ux.md` for evidence):

1. **Hosted SaaS** (iLovePDF, Smallpdf, Sejda, Adobe online, Xodo, Soda, pdfFiller):
   every file is uploaded to someone else's server; free tiers are gated by daily quotas,
   size caps, watermarks, or a paywall that appears *after* the work is done; billing
   traps are common.
2. **Open-source toolkits** (Stirling-PDF, BentoPDF, PDF24): broad feature lists, but the
   UX is a homepage full of single-purpose tools (pick tool, upload, download, repeat);
   the two biggest projects alienated their communities with license pivots, telemetry
   and upsell banners; text editing and forms are still weak or paywalled.

Meanwhile the bar has risen: Firefox 150 reorders pages locally, Chrome 145 annotates,
BentoPDF edits text client-side (Chromium only). "Merge and annotate locally" alone is
no longer a differentiator.

## What we build instead

A **document workspace**:

- Open one or many PDFs into **tabs**. Pages from all open documents can be laid out on a
  single **light table** (a thumbnail grid) and dragged between documents, reordered,
  rotated, deleted, duplicated, split off, or merged. Live preview, marquee selection,
  keyboard operable.
- A **real viewer** underneath: virtualized rendering, smooth zoom, thumbnails, search,
  outline, page-number jump, keyboard navigation.
- **Standards-conformant editing**: annotations written as real PDF annotations with
  appearance streams (they survive in Acrobat, Chrome, Preview); form filling; page
  numbers, headers/footers, watermarks; metadata; passwords; compression that reports
  honest numbers; redaction that actually removes content.
- **Editor-grade history**: non-destructive virtual document model, undo/redo across all
  operations, a visible history panel.
- **Keyboard-first**: every command in a command palette (Cmd/Ctrl+K), every command has a
  shortcut, a shortcut overlay on `?`.
- **Provable privacy**: no backend, no telemetry, no CDN-loaded engines, strict Content
  Security Policy that blocks outbound requests, an in-app "local only" indicator,
  installable as an offline PWA. Deployable as static files on GitHub Pages.

## Principles

1. **Local first, always.** If a feature cannot be done in the browser, we do not do it
   with a server. We say so.
2. **Correctness over feature count.** A merge that silently drops bookmarks or a redaction
   that leaves text searchable is a bug, not a feature. See the correctness list in
   `research/04-feature-feasibility.md`.
3. **One workspace, not forty tools.** Every capability is an action on the document you
   already have open. No upload/download round trips between operations.
4. **Non-generic, quiet design.** Dark by default, tonal surfaces with hairline borders,
   one accent color, restrained translucency only for floating chrome. See `DESIGN.md`.
5. **Honest UI.** When we substitute a font, cannot gain compression, repaired a broken
   file, or stripped an XFA form, the user is told before they commit.
6. **No monetization friction, ever.** No accounts, quotas, upsell banners, "pro"
   directories, or usage metering.
7. **Professional engineering.** English everywhere, Conventional Commits, ADRs for every
   significant decision, CI on every PR, tests for the PDF engine layer with a corpus of
   real-world files.

## Non-goals (for now)

- Server-side processing of any kind.
- Office <-> PDF conversion (no client-side layout engine with acceptable fidelity).
- Certified PDF/A conversion (cannot be validated client-side; we will not claim it).
- Collaboration via a cloud (annotation export/import as files instead).
- Native desktop apps (a Tauri wrapper is a v3 consideration, not a goal).

## Success criteria for v1.0

- A user can drop five PDFs, interleave and reorder their pages on the light table,
  rotate and delete some, and export one merged file whose bookmarks, links, page labels
  and form fields are preserved or deliberately and visibly reconciled.
- The same user can read, search, annotate (highlight, ink, shapes, text, notes), fill a
  form, add page numbers and a watermark, set a password, and compress the result, all in
  one session, with full undo.
- The app loads in under two seconds on a mid-range laptop, works offline after the first
  visit, and makes zero network requests after assets are loaded.
- Everything is verifiable from the source on GitHub and served from GitHub Pages.
