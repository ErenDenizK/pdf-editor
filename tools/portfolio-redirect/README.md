# Portfolio redirect folder for `/pdf-editor/`

The app was served at `https://erendenizk.github.io/pdf-editor/` until the repository was
renamed `pdf-editor` → `recto`. It now lives at `https://erendenizk.github.io/recto/`
(ADR-0016, decision 6: no custom domain for now). GitHub does not redirect a renamed
repository's Pages site, so after the rename `/pdf-editor/` falls through to the owner's user
site, the portfolio repository `ErenDenizK.github.io`. The folder [`pdf-editor/`](pdf-editor/)
here is what that repository serves at `/pdf-editor/`.

| File | What it does |
|---|---|
| `index.html`, `404.html` | The redirect page (the two files are identical). It sends the visitor to `https://erendenizk.github.io/recto/` with the same path remainder, `location.search` (`?lang=tr`) and `location.hash`, via `location.replace`, after probing the new address with a `no-cors` fetch. If the probe fails it says "Recto has moved. Try again in a few minutes." and keeps the link. With `?lang=tr` a Turkish line is added. Without JavaScript, a `<meta http-equiv="refresh">` inside `<noscript>` goes to the new address (path and query are lost there). |
| `redirect.js` | The page's script, loaded from the absolute URL `/pdf-editor/redirect.js` (the CSP allows only same-origin scripts, no inline code). The target address is the `TARGET` constant at the top. |
| `sw.js` | The service-worker kill switch. Browsers that ran the old app still have a Workbox worker registered at `/pdf-editor/sw.js`; on its next update check they get this script instead, which deletes only the old scope's Workbox caches (`workbox-*-https://erendenizk.github.io/pdf-editor/`), keeps the named runtime caches `pdf-editor-ocr`, `pdf-editor-wasm` and `pdf-editor-fonts` (Recto on the same origin reuses them), unregisters itself and reloads open tabs, which then get the redirect page. It has no fetch handler. |

Saved recipes: when the new address is on **another** origin (a later custom domain), the page
first offers "Download your saved recipes" if the old origin's OPFS folder `recipes` or the
IndexedDB database `pdf-editor-recipes` holds any, one `.pdfrecipe.json` file per recipe in the
app's export format (`pdf-editor-recipe`), and waits for the visitor. Today's target is on the
**same** origin, where Recto already sees those recipes, so the offer never shows and the page
redirects at once.

## Copying it into the portfolio repository

1. Copy the folder `tools/portfolio-redirect/pdf-editor/` as it is to the root of
   `ErenDenizK.github.io`, so its files are served at `/pdf-editor/index.html`,
   `/pdf-editor/404.html`, `/pdf-editor/redirect.js` and `/pdf-editor/sw.js`. No build step.
2. GitHub Pages serves only the site root's `404.html` for a missing path, never one in a
   subfolder. So that old deep links (for example `/pdf-editor/about/`) redirect too, also copy
   `pdf-editor/404.html` to the repository root as `404.html`. For paths outside `/pdf-editor/`
   it shows a plain "Page not found" with a link to `/`. If the portfolio has its own 404 page,
   add `<script type="module" src="/pdf-editor/redirect.js"></script>` and the elements the
   script fills (`#status`, `#status-tr`, `#target`, the `#recipes` section) to it instead, and
   allow `script-src 'self'` and `connect-src 'self'` in its CSP.
3. The portfolio must never register a service worker at `/` (ADR-0016 decision 1).
4. Keep the folder indefinitely; it costs nothing (ADR-0016 decision 5 step 8).

## Migration order (ADR-0016 decision 6)

1. **Create `ErenDenizK.github.io`** with a placeholder portfolio `index.html` and this
   `pdf-editor/` folder (plus the root `404.html`, above). Enable Pages for it. While the
   `pdf-editor` repository exists, its project site wins and the folder stays invisible.
2. **Rename the repository `pdf-editor` → `recto`.** `/pdf-editor/` now falls through to the
   portfolio's folder; git and web URLs of the old name redirect. Never create a repository
   named `pdf-editor` again: that would break GitHub's redirects for the old name.
3. **Check `/pdf-editor/` immediately:** `https://erendenizk.github.io/pdf-editor/?lang=tr`
   lands on `https://erendenizk.github.io/recto/?lang=tr` (after Recto's first deploy under
   `/recto/`; until then the page says "Try again in a few minutes"), and
   `https://erendenizk.github.io/pdf-editor/sw.js` answers 200 with this kill switch, not a
   redirect or a 404. A browser that had the old app installed shows the redirect page on its
   next visit, and DevTools → Application → Service workers lists nothing for `/pdf-editor/`.

The custom-domain steps (ADR-0016 decision 5 steps 1, 3, 5 and 6) are deferred. A later move to
a domain needs a second rename and a second redirect folder `/recto/` with its own kill switch.

## Test

```sh
pnpm --filter @pdf-editor/portfolio-redirect test
```

Playwright (Chromium) against a small Node static server on a free `localhost` port (a secure
context, so workers register) that answers like GitHub Pages (`dir/` → `index.html`, missing
path → root `404.html` with status 404) and reads files from disk on every request. The new
address is answered by Playwright routing, never the network. The test proves:

- **Kill switch:** a fake old app registers a Workbox-like worker at `/pdf-editor/sw.js` that
  serves navigations from `workbox-precache-v2-<scope>` and fills `workbox-runtime-<scope>`,
  `pdf-editor-ocr`, `pdf-editor-wasm`, `pdf-editor-fonts` and a successor's
  `workbox-precache-v2-…/recto/`. After the served files are swapped for this folder and the
  page calls `registration.update()`, the tab is reloaded by the kill switch itself onto the
  redirect page from the network, `getRegistrations()` is empty, nothing controls the page, the
  two `/pdf-editor/` Workbox caches are gone and every other cache is still there with its
  entry. With the new address down, the page shows the English and Turkish "moved" lines and
  the link keeps `?lang=tr`; looking for recipes created no `pdf-editor-recipes` database.
- **Redirect:** with the new address up, `/pdf-editor/?lang=tr#page=3`,
  `/pdf-editor/about/?lang=tr#privacy` (through the root `404.html`) and
  `/pdf-editor/index.html?lang=tr` land on the same path, query and hash under `/recto/`, and
  `/pdf-editor//example.com/x` stays on the new site.
- **Root 404:** other portfolio paths get "Page not found" with status 404 and no redirect.
- **Recipes:** with the target on another origin, one recipe in OPFS and one in IndexedDB are
  offered, downloaded with the app's export file names and byte-identical contents, and the
  page waits until the visitor follows the link.
- `index.html` and `404.html` are identical, and the folder holds only the four files above.

Known limit: GitHub Pages sends `Cache-Control: max-age=600`. A browser that fetched the old
app's HTML from the network in the ten minutes before the rename may get it from its HTTP cache
once more when the kill switch reloads the tab; the next update check runs the kill switch
again.
