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
| `tools` | Workspace tools, such as the deterministic fixture generator in `tools/fixtures`. |
| `tooling` | Shared helpers for tool configuration (for example browser resolution for tests). |
| `docs` | Vision, architecture, roadmap, design, ADRs and research. |
| `.github` | CI and deployment workflows, issue and pull request templates. |
| `.changeset` | Pending changelog entries (Changesets). |

## Branches and commits

- Branch from `develop`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(light-table): move pages across documents with keyboard`. Commitlint enforces it.
- Keep commits focused; rebase on `develop` before requesting review; no merge commits in
  feature branches.
- Every PR runs lint, typecheck, unit tests, build, and end-to-end tests on Chromium,
  Firefox and WebKit. All must pass. Add tests for behavior you change.

## Pull requests

- Small and reviewable. One concern per PR.
- Fill in the PR template: what, why, how tested, screenshots for UI changes, ADR link for
  architecture changes.
- Add a Changeset (`pnpm changeset`) for any user-visible change.
- Squash-merge into `develop`. Milestone merges from `develop` to `main` are done by
  maintainers and tagged.

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
