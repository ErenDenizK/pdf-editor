# ADR-0017: Versioning and public releases: `1.0.0-beta.N` first

**Status:** accepted · **Date:** 2026-10-01 · **Deciders:** project lead; confirmed by the owner on 2026-10-01
· **Amends:** ADR-0006

## Context

ADR-0006 planned SemVer tags per milestone, `0.x` until v1.0, and the ROADMAP labelled M1
to M5 as v0.1, v0.2, v1.0, v1.1 and v1.2. None of these was ever published: there is no
`main` on the remote, no tag and no release. All packages are at `0.0.0` in one fixed
Changesets group (`@pdf-editor/*`, private), and the pending changesets are all `minor`.
The owner asked for a scheme that "never says 1.0 before it is earned" (DISCUSSION #23).

SemVer has two pre-1.0 signals. `0.y.z` means "anything may change" and has no defined
exit. A pre-release `1.0.0-beta.N` means "not yet 1.0" and sorts before it:
`1.0.0-beta.0 < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.0 < 1.0.0`. Changesets pre mode
(`changeset pre enter <tag>`) produces exactly these versions, numbered from `.0`. The 1.0
scope (M0–M5, M6 Experience, M7 Presentation) is frozen; what remains is verification.

## Decision

1. **M1–M5 are relabelled internal 0.1–0.5.** They are never tagged or published; the
   ROADMAP says so.
2. **The first public release is `1.0.0-beta.0`, at the end of M7.** Mechanics on `develop`:
   1. add `.changeset/public-beta.md` with every package at `major`;
   2. `pnpm changeset pre enter beta`, then `pnpm changeset version` → `1.0.0-beta.0`, with
      the CHANGELOGs, committed;
   3. PR `develop` → `main`; after the merge, tag `v1.0.0-beta.0` on `main`;
   4. publish the GitHub Release (point 3).
   Later betas: each round of fixes is `changeset version` → `1.0.0-beta.N+1`. Release
   candidate: `pre exit`, `pre enter rc` → `1.0.0-rc.0`. Final: `pre exit`, `version` →
   `1.0.0`. After 1.0, normal SemVer: features minor, fixes patch, breaking major.
3. **One GitHub Release per version**, never one per package. Tag `vX.Y.Z[-beta.N]` (or
   `-rc.N`), titled "Recto X.Y.Z" with "(beta)" while a pre-release, marked
   **pre-release** while the version contains `-`, so it is never "Latest". Notes, in this
   order:
   - **Highlights**: three to five sentences written by hand, at most one clip;
   - **Added**, **Changed**, **Fixed**: from the `@pdf-editor/web` CHANGELOG section, with
     engine and model entries merged in;
   - **Known limitations**: the current "Known behaviours" from the ROADMAP;
   - **Verify**: the link to the CI run that built it and the SHA-256 of the dist zip.
   Attachments: `recto-X.Y.Z-dist.zip` (self-hosting), `SHA256SUMS`, `recto-X.Y.Z-media.zip`.
   No emoji, no "exciting". Packages keep `privatePackages.tag: false`; the release
   workflow creates the single `v` tag from the web package's version.
4. **During the beta only fixes, performance, accessibility, documentation and
   translations land.** Their changesets are `patch` (pre mode keeps the target at
   `1.0.0`). New features wait for 1.1 on a branch.
5. **"Breaking" for an app** means any of:
   - a change to a stored format (recipe format, OPFS and IndexedDB layout, preferences,
     caches the user keeps) without a migration;
   - a change that makes files saved by an earlier version open or export differently in a
     way the user did not ask for (saved-file compatibility);
   - removing a feature;
   - a change to the app's URL or origin.
   After 1.0 a breaking change needs a major version. During the beta it is avoided and,
   when unavoidable, called out under **Changed** with what the user must do.
6. **The in-app About** (command palette "About Recto", and the version line in the privacy
   popover) shows: the name; a "Public beta" label whenever the version contains `-`; the
   version; the build commit (short SHA) and build date; a link to that version's release
   notes; the licence (Apache-2.0) and a link to the source; "Files never leave your
   device"; storage in use (`navigator.storage.estimate()`); offline status. Version,
   commit and date are injected at build time (`__APP_VERSION__`, `__APP_COMMIT__`,
   `__BUILD_DATE__`). The version stays out of the manifest name. The update toast may name
   the incoming version.
7. **The public site is built from `main`**, which is always the latest tag, beta or
   stable (ADR-0006). Previews of `develop` are the PR build artifacts, not the live site.
8. **Exit criteria for 1.0** (all must hold before `pre exit`):
   1. every VISION v1.0 success criterion is an automated test, green on Chromium, Firefox
      and WebKit;
   2. the final name and domain are in place (ADR-0015, ADR-0016);
   3. load time and the zero-external-requests budget are measured in CI;
   4. stored formats are versioned, with migration tests;
   5. at least four weeks and at least two betas without an open blocker or major issue;
   6. an accessibility pass (keyboard and screen reader);
   7. complete English and Turkish;
   8. documentation current (README user guide, `SECURITY.md`, CHANGELOG);
   9. an independent review of the release candidate.

## Consequences

- The ROADMAP, `CONTRIBUTING.md` and `.changeset/README.md` drop "breaking = minor until
  v1.0" and describe pre mode and the beta freeze.
- `.changeset/config.json` may switch to `@changesets/changelog-github` for PR and commit
  links; it needs `GITHUB_TOKEN` when `changeset version` runs.
- While `.changeset/pre.json` exists, every version is a beta; a 1.1 feature branch must
  not merge into `develop` until `pre exit`.
- `deploy.yml` refuses to deploy refs other than `main`; the manual dispatch re-runs a
  deploy of `main`.
- The version string tells users what the label tells them: `1.0.0-beta.3` is not 1.0.

## Alternatives considered

- **`0.9.x` labelled "Public beta".** Rejected: 0.x has no exit semantics and invites
  0.10 and 0.11 if hardening runs long; Changesets cannot reach 0.9 by bumps. Kept as the
  fallback if the owner wants no "1.0" in the string at all.
- **Tagging the old milestone numbers (v1.0–v1.2).** Rejected: they were never published,
  and calling M3 "1.0" would claim what the exit criteria have not shown.
- **One release per package** (`@pdf-editor/web@…`, `@pdf-editor/engine@…`). Rejected:
  the packages move together in one fixed group; three releases per version are noise.
