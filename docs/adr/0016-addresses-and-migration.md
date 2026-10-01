# ADR-0016: Addresses: portfolio root, project paths, custom domain and migration

**Status:** proposed · **Date:** 2026-10-01 · **Deciders:** project lead; the owner confirms
· **Amends:** ADR-0004

## Context

The app has been live at `erendenizk.github.io/pdf-editor/` since 2026-09-27 (Deploy #6,
dispatched from `develop`). Few people can have installed it yet, so moving now is the
cheapest it will ever be. The owner wants a naming structure for `erendenizk.github.io`
sites and a portfolio, and ADR-0015 renames the product to Recto. ADR-0004 recommends a
custom domain before 1.0 to avoid sharing an origin (storage, service worker scope) with
other project sites.

GitHub Pages facts that constrain the move (GitHub documentation, read 2026-10-01):

- One user site per account, from the repository `ErenDenizK.github.io`, served at `/`;
  one project site per repository, served at `/<repository>/`.
- A repository rename redirects everything **except the project site URL**. Creating a new
  repository with the old name breaks the redirects that GitHub keeps for the old one.
- A path that no project site claims falls through to the user site. This is common
  practice but not documented; it is checked once during the migration.
- With Actions publishing, the `CNAME` file is ignored: the domain is set in Settings →
  Pages. A project with its own domain answers `github.io/<repository>/…` with a 301 to
  the domain. A custom domain on the user site spreads to every project without one.
- Storage and service workers are scoped to the origin. A path move on the same origin
  keeps storage; an origin move does not. A service worker whose script URL redirects
  cannot update, so an old worker keeps serving a stale app unless a real `sw.js` answers
  at its exact old URL.

`deploy.yml` already builds with `VITE_BASE_PATH = '/'` when the repository variable
`CUSTOM_DOMAIN` is set, and every path-dependent setting in `apps/web/vite.config.ts`
(manifest `id`, `scope`, `start_url`, the navigation fallback, runtime cache matchers)
derives from that base.

## Decision

1. **`ErenDenizK.github.io` becomes the owner's portfolio** at `erendenizk.github.io/`. It
   never registers a service worker at its root: a root-scoped worker would intercept
   first visits to every project path. It also holds redirect folders for moved apps.
2. **Project sites use short lowercase repository names** (kebab-case) and live at
   `erendenizk.github.io/<repository>/`. A renamed repository's old name is never reused.
   **No repository named `pdf-editor` is ever created again.**
3. **Recto gets its own origin on a custom domain**, recommended `rectopdf.app` (apex as
   the canonical origin, `www` configured so GitHub redirects it), or a subdomain of a
   personal domain if the app will always be the owner's personally. The move happens **in
   the same step as the repository rename `pdf-editor` → `recto`**, so the origin changes
   once.
4. **The app stays at the root of its site.** No `/app/` path and no marketing page in front
   of the tool; the about page is a sibling at `/about/` (`docs/specs/presentation.md` §3).
5. **Migration order** (no link breaks):
   1. Buy the domain. Verify it at account level (Settings → Pages → Verified domains)
      before anything points at it, to prevent takeover. Add DNS: `www` CNAME to
      `erendenizk.github.io`; apex A and AAAA records to GitHub's Pages addresses.
   2. Create `ErenDenizK.github.io` with a placeholder portfolio `index.html` and the folder
      `/pdf-editor/` containing:
      - `index.html` and `404.html` that redirect to the new origin with the same path
        remainder, `location.search` (the app uses `?lang=tr`) and `location.hash`, via
        `location.replace`, plus a `<meta http-equiv="refresh">` and a visible link. Before
        redirecting they probe the new origin with a `no-cors` fetch; if it fails (the
        certificate may still be provisioning) they say "Recto has moved. Try again in a
        few minutes." and keep the link.
      - `sw.js`, a hand-written kill switch: `skipWaiting()` on install; on activate, delete
        only the caches belonging to the `/pdf-editor/` scope (Workbox precache names carry
        the scope URL), unregister, then navigate open clients to the redirect page. The
        named runtime caches (`pdf-editor-ocr`, `-wasm`, `-fonts`) are left alone, because
        a same-origin successor (the fallback below) uses them. vite-plugin-pwa's
        `selfDestroying` is not used: it deletes every cache on the origin.
      While the `pdf-editor` repository exists, its project site wins and the folder stays
      invisible.
   3. Set the repository variable `CUSTOM_DOMAIN` to the domain. It affects the next build.
   4. Rename the repository `pdf-editor` → `recto`. `/pdf-editor/` now falls through to the
      portfolio's folder (check it immediately); git and web URLs of the old name redirect.
   5. Set the custom domain on `recto` (Settings → Pages) and re-run Deploy. The base
      becomes `/`. `github.io/recto/…` now 301s to the domain; no worker was ever
      registered under `/recto/`, so the redirect strands nobody.
   6. Enforce HTTPS once the certificate is issued (up to 24 hours).
   7. Update the docs and links: repository homepage field, README, `ARCHITECTURE.md` §7,
      ADR-0004's recommendation (met), media URLs, issue templates, `SECURITY.md`.
   8. Keep the `/pdf-editor/` folder indefinitely; it costs nothing.
6. **Fallback if no domain is bought**: steps 2 and 4 only, with the redirect pages pointing
   to `erendenizk.github.io/recto/`. That is a same-origin move, so recipes, kept OCR packs
   and preferences survive. A later domain move then needs a second rename (for example to
   `recto-app`) and a second redirect folder `/recto/` with its own kill switch.
7. **The user site gets no custom domain** while redirect folders are doing their job: a
   user-site domain would move every domainless project site and redirect the folders.

## Consequences

- After 1.0 the origin never changes (ADR-0017 counts an origin change as breaking).
- Storage does not cross origins. Users of the github.io build re-download OCR packs, reset
  preferences and move recipes with the existing export and import. The redirect page may
  offer "Download your saved recipes" first: it is same-origin with the old app and can
  read the `recipes` OPFS folder and the `pdf-editor-recipes` database.
- Installed copies of the old PWA are a different app (manifest `id` changes); after the
  kill switch runs, users install from the new origin.
- The `pdf-editor-*` runtime caches on the github.io origin stay until the browser evicts
  them under storage pressure. This is the price of never deleting another app's data.
- `.app` is on the HSTS preload list; GitHub's Let's Encrypt certificate covers it.
- The portfolio repository is a second repository to keep; it holds static files only.

## Alternatives considered

- **Stay at `erendenizk.github.io/pdf-editor/`.** Rejected: a generic name in the URL, an
  origin shared with every other project site, and no clean way to rename later.
- **Rename without a domain now, add a domain later.** Rejected as the plan, kept as the
  fallback: users would reinstall and re-import twice, and GitHub's 301 from
  `github.io/recto/` would strand the `/recto/` worker without a second rename.
- **Recreate a `pdf-editor` repository holding only redirects.** Rejected: GitHub's
  rename redirects for git and web stop working when the old name is reused.
- **A redirect instead of a kill switch at `/pdf-editor/sw.js`.** Rejected: a service
  worker script fetch that redirects fails, and a 404 also leaves the old worker running.
- **App under `/app/` with a landing page at the root.** Rejected in the presentation
  research: it changes the PWA scope, adds a page between users and the tool, and needs
  two builds in one artifact.
