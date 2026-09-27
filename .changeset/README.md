# Changesets

This folder is managed by [Changesets](https://changesets.dev). Every pull request with a
user-visible change adds one small Markdown file here describing it:

```sh
pnpm changeset
```

Pick the affected packages and the bump type (all packages are `0.x`, so breaking changes
are `minor` until v1.0), then write one or two sentences for the changelog. Maintainers run
`pnpm changeset version` when a milestone is merged from `develop` into `main`; that
consumes these files and updates `CHANGELOG.md` (ADR-0006).

Read more in the [Changesets FAQ](https://changesets.dev/faq).
