/*
 * Redirect for the old address of the app, `erendenizk.github.io/pdf-editor/` (ADR-0016
 * decision 5 step 2 and decision 6). Loaded by `index.html` and `404.html` in this folder,
 * which the owner copies into the portfolio repository `ErenDenizK.github.io`.
 *
 * 1. Work out the new address: the path after `/pdf-editor/`, `location.search` (the app
 *    reads `?lang=tr`) and `location.hash` carry over to `TARGET`.
 * 2. If the new address is on another origin (a later custom domain) and the old origin
 *    holds saved recipes, offer "Download your saved recipes" first and do not move on by
 *    itself: storage does not cross origins. On the same origin (the github.io fallback that
 *    is the plan today) the recipes are already there for Recto, so nothing is offered.
 * 3. Otherwise probe the new address with a `no-cors` fetch and `location.replace` it. If
 *    the probe fails (the site is not published yet, or a certificate is still being
 *    issued) say "Recto has moved. Try again in a few minutes." and keep the link.
 *
 * Plain script, no build step. Absolute `/pdf-editor/` URL in the HTML, so the same page
 * also works as the portfolio's root `404.html` (GitHub Pages serves only the root one).
 */
/* global document, location, indexedDB */

/** Where the app lives now. A second move changes this line and the HTML's fallbacks. */
const TARGET = new URL('https://erendenizk.github.io/recto/');
/** The folder this page answers for. */
const OLD_PREFIX = '/pdf-editor/';
/** How long the probe may take before the page gives up and shows the link. */
const PROBE_TIMEOUT_MS = 8000;

/** Storage names the old app used (ADR-0015 §3, apps/web/src/batch/recipes-store.ts). */
const RECIPES_DIRECTORY = 'recipes';
const RECIPES_DATABASE = 'pdf-editor-recipes';
const RECIPES_STORE = 'recipes';
/** Stored recipe files are `<id>.json`; `<id>.meta.json` holds only times. */
const RECIPE_FILE = /^[A-Za-z0-9_-]{1,64}\.json$/;
/** The recipe export format id (packages/document-model/src/recipe.ts, RECIPE_FORMAT). */
const RECIPE_FORMAT = 'pdf-editor-recipe';
const RECIPE_FILE_EXTENSION = '.pdfrecipe.json';

const turkish = (new URLSearchParams(location.search).get('lang') ?? '').startsWith('tr');

/** @param {string} id */
function element(id) {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing #${id}`);
  return found;
}

/**
 * Shows an English line and, for `?lang=tr`, its Turkish line.
 * @param {string} english
 * @param {string} turkishText
 * @param {'info' | 'warning'} tone
 */
function say(english, turkishText, tone = 'info') {
  const status = element('status');
  const statusTr = element('status-tr');
  status.textContent = english;
  statusTr.textContent = turkishText;
  statusTr.hidden = !turkish;
  status.dataset.tone = tone;
  statusTr.dataset.tone = tone;
}

/**
 * The new address for this page's URL, or `undefined` when the path is not under
 * `/pdf-editor/` (the page is serving as the portfolio's general 404).
 * @returns {URL | undefined}
 */
function destination() {
  const path = location.pathname;
  let rest;
  if (path === OLD_PREFIX.slice(0, -1)) rest = '';
  else if (path.startsWith(OLD_PREFIX)) rest = path.slice(OLD_PREFIX.length);
  else return undefined;
  // The old entry document; the new site's entry is its directory.
  if (rest === 'index.html') rest = '';
  // Appended as text, never resolved as a relative URL, so `//host` cannot leave the site;
  // anything that still ends up outside TARGET falls back to TARGET itself.
  const url = new URL(TARGET.href + rest.replace(/^\/+/, '') + location.search + location.hash);
  if (url.origin !== TARGET.origin || !url.pathname.startsWith(TARGET.pathname)) {
    return new URL(TARGET.href + location.search + location.hash);
  }
  return url;
}

/**
 * Whether the new site answers. Cross-origin, a `no-cors` response is opaque: reaching the
 * server is all it can tell. Same-origin (the github.io fallback) the status is visible, so a
 * 404 from the portfolio, meaning `/recto/` is not published yet, also counts as a failure.
 * @returns {Promise<boolean>}
 */
async function probe() {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(TARGET.href, {
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    return response.type === 'opaque' || response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recipe files from the OPFS folder `recipes`, without creating it.
 * @returns {Promise<string[]>}
 */
async function opfsRecipeTexts() {
  if (typeof navigator.storage?.getDirectory !== 'function') return [];
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(RECIPES_DIRECTORY);
    const texts = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== 'file' || !RECIPE_FILE.test(name)) continue;
      const file = await /** @type {FileSystemFileHandle} */ (handle).getFile();
      texts.push(await file.text());
    }
    return texts;
  } catch {
    // No folder (NotFoundError), or OPFS refused: nothing to offer from here.
    return [];
  }
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function settle(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/**
 * Recipe texts from the IndexedDB database `pdf-editor-recipes` (records `{ id, text, … }`),
 * without creating the database where it does not exist.
 * @returns {Promise<string[]>}
 */
async function indexedDbRecipeTexts() {
  if (typeof indexedDB === 'undefined') return [];
  try {
    if (typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === RECIPES_DATABASE)) return [];
    }
    const open = indexedDB.open(RECIPES_DATABASE);
    // Only reached for a database that does not exist yet (or without `databases()`):
    // aborting the upgrade leaves no empty database behind.
    open.onupgradeneeded = () => {
      open.transaction?.abort();
    };
    const db = await settle(open);
    try {
      if (!db.objectStoreNames.contains(RECIPES_STORE)) return [];
      const store = db.transaction(RECIPES_STORE, 'readonly').objectStore(RECIPES_STORE);
      const records = /** @type {unknown[]} */ (await settle(store.getAll()));
      return records
        .map((record) =>
          typeof record === 'object' && record !== null && 'text' in record ? record.text : null,
        )
        .filter((text) => typeof text === 'string');
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * The saved recipes as export files: exactly the stored text (the app stores what "Export"
 * writes), named like the app's export. Anything that is not a recipe file is skipped.
 * @returns {Promise<{ name: string, text: string }[]>}
 */
async function savedRecipes() {
  const texts = [...(await opfsRecipeTexts()), ...(await indexedDbRecipeTexts())];
  /** @type {{ name: string, text: string }[]} */
  const recipes = [];
  const seen = new Set();
  for (const text of texts) {
    if (seen.has(text)) continue;
    seen.add(text);
    try {
      const parsed = /** @type {unknown} */ (JSON.parse(text));
      if (typeof parsed !== 'object' || parsed === null) continue;
      if (!('format' in parsed) || parsed.format !== RECIPE_FORMAT) continue;
      const name = 'name' in parsed && typeof parsed.name === 'string' ? parsed.name : '';
      recipes.push({ name, text });
    } catch {
      // Not JSON: left alone.
    }
  }
  return recipes;
}

/**
 * The app's export file name (apps/web/src/batch/deliver.ts, safeFileStem).
 * @param {string} name
 */
function recipeFileName(name) {
  // eslint-disable-next-line no-control-regex
  const stem = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, '_').trim();
  return `${stem === '' ? 'recipe' : stem}${RECIPE_FILE_EXTENSION}`;
}

/**
 * Lists one download link per recipe and wires the button to start them all.
 * @param {{ name: string, text: string }[]} recipes
 */
function offerRecipes(recipes) {
  const count = recipes.length;
  element('recipes-text').textContent =
    `Your ${count === 1 ? 'saved recipe stays' : `${count} saved recipes stay`} at this ` +
    'address. Download them, then import each file in Recto (Batch, Import).';
  const textTr = element('recipes-text-tr');
  textTr.textContent =
    `Kayıtlı ${count} tarifiniz bu adreste kalır. İndirin, sonra her dosyayı Recto'da ` +
    'içe aktarın (Toplu işlem, İçe aktar).';
  textTr.hidden = !turkish;
  const list = element('recipe-files');
  /** @type {HTMLAnchorElement[]} */
  const links = [];
  for (const recipe of recipes) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([recipe.text], { type: 'application/json' }));
    link.download = recipeFileName(recipe.name);
    link.textContent = link.download;
    const item = document.createElement('li');
    item.append(link);
    list.append(item);
    links.push(link);
  }
  const button = element('recipes-download');
  if (turkish) button.textContent = 'Download your saved recipes · Kayıtlı tarifleri indir';
  button.addEventListener('click', () => {
    // One click per file, spaced out: browsers may drop downloads started in the same tick.
    links.forEach((link, index) => {
      setTimeout(() => {
        link.click();
      }, index * 250);
    });
  });
  element('recipes').hidden = false;
}

function notFound() {
  document.title = 'Page not found';
  document.querySelector('h1')?.replaceChildren('Page not found');
  say('This address does not exist.', 'Bu adres yok.');
  const link = /** @type {HTMLAnchorElement} */ (element('target'));
  link.href = '/';
  link.textContent = 'Go to the home page';
}

async function main() {
  const url = destination();
  if (url === undefined) {
    notFound();
    return;
  }
  const link = /** @type {HTMLAnchorElement} */ (element('target'));
  link.href = url.href;
  say(
    'pdf-editor is now Recto, at a new address. Taking you there…',
    'pdf-editor artık Recto, yeni bir adreste. Sizi oraya götürüyoruz…',
  );

  const recipes = url.origin === location.origin ? [] : await savedRecipes();
  const reachable = await probe();
  if (recipes.length > 0) {
    offerRecipes(recipes);
    if (reachable) {
      say(
        'pdf-editor is now Recto, at a new address.',
        'pdf-editor artık Recto, yeni bir adreste.',
      );
    }
  } else if (reachable) {
    location.replace(url.href);
    return;
  }
  if (!reachable) {
    say(
      'Recto has moved. Try again in a few minutes.',
      'Recto taşındı. Birkaç dakika sonra yeniden deneyin.',
      'warning',
    );
  }
}

void main();
