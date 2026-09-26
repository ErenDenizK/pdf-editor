# ADR-0003: Frontend stack

**Status:** proposed · **Date:** 2026-09-26

## Context

A canvas-heavy document editor with large virtualized grids, drag-and-drop across
documents, and all heavy work in workers. The UI framework is not on the hot path; the
ecosystem for headless primitives, virtualization and drag-and-drop is. The project wants
outside contributors. See `docs/research/03-platform-constraints.md` §5–7.

## Decision

- **Vite 8**, **TypeScript 7** (strict, `tsgo` for typecheck), **pnpm** workspaces
  (`apps/web`, `packages/engine`, `packages/document-model`, `packages/ui`).
- **React 19** with the React Compiler.
- **Zustand** for stores; a custom snapshot history stack (ADR-0005); a small explicit
  state machine for tool/drag modes.
- **TanStack Virtual** for grids and rails.
- **Atlassian pragmatic-drag-and-drop** for page and file drag-and-drop, with our own
  keyboard alternative and live-region announcements.
- **Comlink** for worker RPC behind our interfaces.
- **CSS Modules + design tokens as custom properties**; no utility framework, no
  component library. Headless accessibility primitives for menus/dialogs/tooltips
  (candidate: Radix Primitives; Base UI to be evaluated in M0).
- **Paraglide JS** for i18n (compiled, typed). Lucide icons.
- Quality: ESLint 10 flat config + typescript-eslint (type-aware), Biome as formatter,
  Vitest 5 (browser mode for engine tests), Playwright 1.63, lefthook + commitlint,
  Changesets, Renovate, Lighthouse CI.

## Consequences

- Largest contributor pool and library ecosystem; React's per-render cost is irrelevant
  because canvases and workers do the heavy lifting and stores are selector-based.
- No generic component-library look; every control is ours, which costs design time and is
  the point.
- Biome formats, ESLint lints; never two formatters.

## Alternatives considered

- **Svelte 5**: faster fine-grained updates and smaller bundles; smaller ecosystem for
  headless primitives and DnD, fewer contributors. A reasonable choice; not chosen.
- **SolidJS 2 / Preact 11**: both at release-candidate stage in Sept 2026; churn risk.
- **dnd-kit**: core frozen since 2024, rewrite pre-1.0; collision cost grows with
  droppable count. Rejected.
- **Tailwind**: viable, but tokens + CSS Modules keep the design system explicit and
  reviewable. Can be revisited if velocity suffers.
