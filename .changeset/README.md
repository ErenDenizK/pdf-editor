# Changesets

This folder is managed by [Changesets](https://changesets.dev). Every pull request with a
user-visible change adds one small Markdown file here describing it:

```sh
pnpm changeset
```

All `@pdf-editor/*` packages move together in one fixed group, so pick any affected package
and the bump type, then write one or two sentences for the changelog in the app's words. The
release notes sort entries into Added, Changed and Fixed: start the summary with `Added:`,
`Changed:` or `Fixed:` to choose the section; without a prefix, `major` and `minor` entries
go to Added and `patch` entries to Fixed.

## Versions (ADR-0017)

The first public release is `1.0.0-beta.0`. Until `1.0.0`, the repository is in Changesets
**pre mode** (`.changeset/pre.json` exists), so every `pnpm changeset version` produces a
pre-release: `1.0.0-beta.0`, `1.0.0-beta.1`, and so on.

- **During the beta, only fixes, performance, accessibility, documentation and translations
  land on `develop`.** Their changesets are `patch`; pre mode keeps the target at `1.0.0`.
  New features wait for 1.1 on a branch that is not merged into `develop` until pre mode
  ends.
- **Breaking** for this app means a stored format changed without a migration (recipes,
  OPFS and IndexedDB layout, preferences, kept caches), files saved earlier open or export
  differently without the user asking, a feature removed, or the app's URL or origin
  changed. During the beta it is avoided; when it cannot be, the changeset starts with
  `Changed:` and says what the user must do. After 1.0 it needs a `major` changeset.
- In pre mode, `changeset version` keeps the changeset files and lists them in `pre.json`;
  they are removed when pre mode ends.

## Commands (maintainers)

| Step | Commands |
|---|---|
| First beta | add `public-beta.md` with every package at `major`; `pnpm changeset pre enter beta`; `pnpm changeset version` → `1.0.0-beta.0` |
| Next beta | `pnpm changeset version` → `1.0.0-beta.N+1` |
| Release candidate | `pnpm changeset pre exit`; `pnpm changeset pre enter rc`; `pnpm changeset version` → `1.0.0-rc.0` |
| 1.0 | `pnpm changeset pre exit`; `pnpm changeset version` → `1.0.0` |

The versioned packages, the CHANGELOGs and `.github/release-notes.md` go to `main` in a
release pull request; the release workflow then tags `v<version>` and publishes the GitHub
Release. Changesets itself creates no tags (`privatePackages.tag: false`). The whole
procedure is in [`CONTRIBUTING.md`](../CONTRIBUTING.md#releases).

Read more in the [Changesets FAQ](https://changesets.dev/faq) and on
[pre-releases](https://github.com/changesets/changesets/blob/main/docs/prereleases.md).
