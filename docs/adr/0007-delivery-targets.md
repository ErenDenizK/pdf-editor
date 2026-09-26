# ADR-0007: Delivery targets — web first, desktop as escalation path

**Status:** accepted · **Date:** 2026-09-26

## Context

The primary target is a static web app on GitHub Pages. The owner has stated two
fallbacks if the web target cannot deliver the intended scope: (a) pivot entirely to a
desktop application, or (b) keep a light web edition and ship a fuller downloadable
edition that includes features the browser cannot host.

What a desktop shell would actually unlock, given the permissive-license stack:
multi-threading and larger memory (no 2 GiB WASM ceiling, native PDFium possible), file
associations and "open with", saving in place on every OS, unbounded local font access,
very large optional components (LibreOffice-class converters), and network-dependent
signature features (timestamps, OCSP) without CORS constraints. It does not change
licensing: AGPL engines would still make the desktop edition AGPL.

## Decision

1. **Web first.** Milestones M0–M3 target the browser only. No feature in the v1.0 scope
   depends on a desktop shell.
2. **Platform-agnostic core.** `packages/document-model` and `packages/engine` must not
   depend on DOM APIs except through injected adapters (file I/O, worker creation, storage).
   This is enforced by ESLint environment configuration and by tests running in Node where
   possible. The UI in `apps/web` is the only browser-specific layer.
3. **Escalation triggers.** A desktop edition (Tauri 2, Rust shell, same web UI) is started
   only if one of these holds after M3: (a) a v1.0 success criterion cannot be met in the
   browser on the supported floor; (b) a v1.x feature is judged essential and infeasible
   in the browser (candidates: LTV signatures, Office conversion, > 1 GB documents);
   (c) measured user demand for file associations and offline-by-default behaviour.
4. **If escalated, edition (b) is preferred over (a):** the web edition stays the
   canonical, always-free product; the desktop edition is the same code with extra
   capabilities detected at runtime, never a different UI.
5. Capability detection, not platform detection: every feature that depends on an API
   (File System Access, OPFS, Local Font Access, threads) checks for the capability and
   degrades with an honesty notice. The desktop shell simply provides more capabilities.

## Consequences

- Slight extra discipline in the core packages now; a cheap desktop path later.
- Roadmap item M6 "optional Tauri desktop shell" becomes the standing escalation plan.
