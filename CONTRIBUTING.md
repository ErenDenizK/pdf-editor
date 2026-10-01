# Contributing

Thank you for considering a contribution. This project is run with the discipline of a
professional engineering team; the rules below exist so that quality stays high as the
contributor base grows.

## Language

All code, comments, commit messages, issues, pull requests, and documentation are written
in **English**. User-facing strings live in locale files and are translated separately.

## Before you start

1. Read `docs/VISION.md`, `docs/ARCHITECTURE.md` and the ADRs in `docs/adr/`.
2. Open an issue (or pick one) before starting anything larger than a small fix. Design
   discussions happen in the issue; architectural changes need an ADR in the PR.
3. Set up the workspace. You need Node.js 22 (see `.nvmrc`) and pnpm, which Corepack
   provides at the version pinned in `package.json`:

   ```sh
   corepack enable       # once per machine; provides the pinned pnpm
   pnpm install          # installs dependencies and the Git hooks (lefthook)
   pnpm dev              # starts the web app at http://localhost:5173
   pnpm run ci           # format check, lint, typecheck, tests, build: what CI runs
   ```

   Other useful commands: `pnpm test` (unit and browser-mode tests), `pnpm test:e2e`
   (Playwright; run `pnpm exec playwright install` once), `pnpm format` (apply Biome
   formatting), `pnpm changeset` (describe a user-visible change). Use `pnpm run ci`, not
   `pnpm ci`: the latter is a reserved pnpm command.

## Repository layout

| Path | Contents |
|---|---|
| `apps/web` | The web application: React UI, workers wiring, Vite and Playwright config, `e2e/` tests. |
| `packages/engine` | Engine interfaces and their adapters (PDFium, pdf-lib). Tests run in Vitest browser mode. |
| `packages/document-model` | Virtual document model, commands and history. Platform-agnostic: no DOM (ADR-0007). |
| `test/fixtures` | The PDF test corpus, with provenance in its `README.md`. |
| `tools` | Workspace tools: the deterministic fixture generator (`tools/fixtures`), the README and about-page media recorder (`tools/media`), the copy check (`tools/copy-check`), the redirect folder for the old address (`tools/portfolio-redirect`). |
| `tooling` | Shared helpers for tool configuration (for example browser resolution for tests). |
| `docs` | Vision, architecture, roadmap, design, ADRs and research. |
| `.github` | CI, deployment and release workflows, the release-notes template, issue and pull request templates. |
| `.changeset` | Pending changelog entries (Changesets). |

## Branches and commits

- Branch from `develop`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(light-table): move pages across documents with keyboard`. Commitlint enforces it.
- Keep commits focused; rebase on `develop` before requesting review; no merge commits in
  feature branches.
- Every PR runs lint, typecheck, unit tests, build, end-to-end tests on Chromium, Firefox
  and WebKit, and the copy and link checks. All must pass. Add tests for behavior you
  change.

## Pull requests

- Small and reviewable. One concern per PR.
- Fill in the PR template: what, why, how tested, screenshots for UI changes, ADR link for
  architecture changes.
- Add a Changeset (`pnpm changeset`) for any user-visible change (see
  [`.changeset/README.md`](.changeset/README.md)).
- Squash-merge into `develop`. Only release pull requests go from `develop` to `main`
  (see [Releases](#releases)).

## Public copy

The README, the about page (`apps/web/about/`) and the release notes follow the copy rules of
`docs/specs/presentation.md` §1.2: mechanism words, a limit next to each capability, and
evidence one click away (a test, a CI step, a source file or an ADR). The `docs` CI job runs
the copy check, which rejects the banned words of §1.3, exclamation marks and emoji, and a
link check:

```sh
node --experimental-strip-types tools/copy-check/check.ts   # or: pnpm --filter @pdf-editor/copy-check check
```

## Releases

Versions follow ADR-0017: the first public release is `1.0.0-beta.0`, one GitHub Release per
version, tagged `v<version>` from the web package's version. `main` always holds the latest
release, and the public site is built from it.

**The beta freeze.** While `.changeset/pre.json` exists (Changesets pre mode), only fixes,
performance, accessibility, documentation and translations are merged into `develop`, each
with a `patch` changeset. Features wait for 1.1 on a branch that is not merged until pre mode
ends. What counts as breaking, and the commands for each step, are in
[`.changeset/README.md`](.changeset/README.md).

**Cutting a release** (the owner, or a maintainer the owner names):

1. On a branch from `develop`, enter pre mode once (`pnpm changeset pre enter beta`, with
   `.changeset/public-beta.md` at `major` for the first beta), then run
   `pnpm changeset version`. Check the new version in `apps/web/package.json` and the
   CHANGELOGs.
2. Update `.github/release-notes.md`: its first line names the new version
   (`<!-- version: 1.0.0-beta.0 -->`), and Highlights (three to five sentences) and Known
   limitations (from the ROADMAP's known behaviours) are written by hand. The release
   workflow refuses a template written for another version.
3. Merge that into `develop`, then open the release pull request from `develop` to `main`.
   CI must be green; the owner merges it with linear history (ADR-0006).
4. Nobody tags by hand. On the merge, `release.yml` reads the version, builds the dist zip
   (for the root of a static host) and the media zip, creates the tag `v<version>` on the
   merged commit, writes `SHA256SUMS` and the notes (Added, Changed and Fixed from the
   CHANGELOGs), and publishes the GitHub Release, marked pre-release while the version
   contains `-`. `deploy.yml` deploys the same commit to GitHub Pages.
5. If a run fails, fix the cause on `develop` and release again, or re-run the workflow on
   `main` from the Actions tab; it skips a version whose release already exists.

## Code standards

- TypeScript strict; no `any` without a comment explaining why.
- UI code never imports a PDF engine package directly; it goes through the interfaces in
  `packages/engine`.
- Anything that produces PDF bytes has a golden-file test that re-parses the output.
- Accessibility is not optional: keyboard path, focus management, and ARIA for every new
  control.
- Design tokens only; no hard-coded colors or spacing in components.

## Test corpus

PDF fixtures in `test/fixtures/` must be redistributable (public domain, CC0, or created by
us) and documented in `test/fixtures/README.md` with provenance and what each file exercises.

## Security

Report vulnerabilities privately as described in `SECURITY.md`. The application has no
server; most security issues will be about malformed PDFs crashing a worker or leaking data
between documents.

## Conduct

Be kind, be direct, assume good faith. Participation is governed by `CODE_OF_CONDUCT.md`
(Contributor Covenant 2.1).
