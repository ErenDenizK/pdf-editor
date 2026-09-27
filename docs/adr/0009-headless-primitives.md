# ADR-0009: Headless accessibility primitives: Base UI

**Status:** accepted · **Date:** 2026-09-27

## Context

ADR-0003 rules out a component library but calls for headless primitives for the widgets
whose accessibility is expensive to get right by hand: dialogs (focus trap, scroll lock,
focus return, `Esc`), tooltips (hover and focus intent, delay groups, collision-aware
positioning), menus (roving focus, typeahead, submenus) and popovers. Radix Primitives
was the candidate; Base UI was to be evaluated in M0 (`DISCUSSION.md` item 10).

Both were installed and used for the M0 shell's palette (Dialog), tooltips, the zoom menu
(Menu) and the privacy indicator (Popover). Findings on 2026-09-27:

| | Radix Primitives | Base UI |
|---|---|---|
| Packages | one per primitive (`@radix-ui/react-dialog` 1.1.23, `-tooltip` 1.2.16, `-dropdown-menu` 2.1.24, `-popover` 1.1.23), each with ~15 internal `@radix-ui/*` deps | one package, `@base-ui/react` 1.8.0 (renamed from `@base-ui-components/react`, whose last release is a deprecated 1.0.0-rc.0) |
| Licence | MIT | MIT |
| Release cadence | last stable 2026-07-24; release-candidate builds until 2026-07-31, nothing since | stable 1.0 in Dec 2025, then a minor release every month (1.8.0 on 2026-09-04) |
| Size, min+gzip, the four primitives together | ~40 KB | ~67 KB |
| Size per primitive (Tooltip / Dialog / Menu) | 21 / 15 / 34 KB | 37 / 25 / 56 KB |
| Composition | `asChild` + Slot | `render` prop (element or function); state via `data-*` attributes |
| Scope | the four we need, plus Toolbar, Tabs, Slider etc. as separate packages | one coherent set that also covers Toolbar, Tabs, Slider, NumberField, Toast, ScrollArea, Combobox and Autocomplete, which the M1–M2 properties panel and tool bars need |
| CSP | inline styles; `react-remove-scroll` supports a nonce | inline styles; `CSPProvider` for nonces |

Sizes were measured by bundling each set with the project's Vite 8 build (React
external, production `NODE_ENV`); Base UI's numbers include the Floating UI code it
shares across primitives.

Behaviour checked in the shell: modal Dialog traps focus, locks scroll, closes on `Esc`
and outside press, and returns focus to the trigger; `initialFocus`/`finalFocus` accept
refs, which the palette needs to focus its input. Tooltip opens on hover and on keyboard
focus, groups delays through a Provider, and is correctly not announced (triggers carry
their own `aria-label` and `aria-keyshortcuts`). Menu offers radio items, typeahead and
looped arrow navigation. Popover supports title/description association. Both libraries
passed the same checks; neither needed workarounds for React 19 or the React Compiler.

## Decision

Use **Base UI** (`@base-ui/react`) for dialogs, tooltips, menus and popovers, and adopt
its Toolbar, Tabs, Slider and NumberField where M1–M2 need them rather than hand-rolling
more roving-focus widgets. Remove the Radix packages.

Rules:

- Import per entry point (`@base-ui/react/dialog`, not the barrel) so tree-shaking stays
  obvious in review.
- Styling stays in CSS Modules against Base UI's `data-*` state attributes
  (`data-open`, `data-highlighted`, `data-starting-style` / `data-ending-style` for
  transitions). No inline style props in our code.
- A popup must stay rendered inside its `Portal` for the whole close transition; let the
  Portal unmount it. Unmounting the popup ourselves leaves the backdrop stuck in its exit
  state, where it keeps intercepting pointer events. This happened in M0 and is covered
  by a component test.

## Consequences

- One dependency with one version to track. Renovate groups it, and upgrades are monthly
  minor releases instead of a dozen coordinated package bumps.
- Base UI costs about 27 KB more gzipped than Radix for the same four primitives. Tooltip
  (37 KB, shared with Menu and Popover) is on the critical path. Mitigation: lazy-load the
  palette and shortcut overlay when the Lighthouse budget (ARCHITECTURE.md §8) calls for
  it. Dialog is the only primitive they need that the first paint does not already pay for.
- Base UI's larger component set (Toolbar, NumberField, Slider, Combobox) means fewer
  hand-built widgets, and so fewer accessibility bugs we would own ourselves.
- Contributors who know Radix need to learn `render` instead of `asChild`; the concepts
  map one to one.

## Alternatives considered

- **Radix Primitives**: smaller, battle-tested, and the most familiar to contributors. It
  was not chosen because there has been no stable release since 2026-07-24 and no
  release of any kind since 2026-07-31, because the package-per-primitive layout multiplies version management, and because we
  would still need extra packages (or our own code) for the M1–M2 widgets that Base UI
  ships. Radix remains a drop-in fallback: our wrappers (`src/ui/Tooltip.tsx`, the
  palette, menu and popover call sites) are the only files that import primitives.
- **React Aria (Adobe)**: the strongest accessibility engineering, but it is hooks-first
  and a much larger API surface for four widgets. Worth revisiting for the light-table
  grid (`role="grid"`, DESIGN.md §5), where its collection and selection model may pay off.
- **Hand-rolled**: fine for the tab bar, rail and tool bar (done in M0 with roving
  tabindex), but not for focus-trapping dialogs and collision-aware positioning.

## Discussion summary

Accepted by the project lead on 2026-09-27 after reviewing the evaluation and the M0 shell.
Bundle cost is accepted in exchange for one coherent, actively released set that covers
the M1–M2 widgets.
