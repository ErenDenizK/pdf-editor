# ADR-0006: Branching, versioning and commit conventions

**Status:** proposed · **Date:** 2026-09-26

## Decision

- `main` holds releasable code only; every commit on `main` is deployed to GitHub Pages.
  Protected: PR required, CI green, linear history (squash or rebase merge).
- `develop` is the integration branch for the next milestone. Feature branches
  (`feat/light-table-dnd`, `fix/outline-remap`, `docs/adr-0007`) branch from and merge
  back into `develop` via PR.
- Milestones are merged from `develop` into `main` and tagged `vMAJOR.MINOR.PATCH`
  (SemVer; `0.x` until v1.0). Changesets generate `CHANGELOG.md` and the GitHub Release.
- **Conventional Commits** enforced by commitlint: `feat`, `fix`, `docs`, `refactor`,
  `perf`, `test`, `build`, `ci`, `chore`, with scopes such as `engine`, `model`, `ui`,
  `light-table`, `viewer`, `export`, `docs`. Breaking changes carry `!` and a footer.
- All code, comments, commit messages, issues, PRs and documentation are in English.
- ADRs for every decision that is expensive to reverse; a PR that changes architecture
  links its ADR.

## Note on the current session

This planning work is being pushed to the branch `claude/zealous-pasteur-6mqn1l`, the
branch assigned to the automated session. The project owner decides whether to rename it
to `develop` or to merge it into a newly created `develop`; the automated session does not
push to other branches without explicit permission.
