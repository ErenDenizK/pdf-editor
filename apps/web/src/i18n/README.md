# i18n

Messages are compiled by [Paraglide JS](https://paraglidejs.com) (ADR-0010) from
`apps/web/messages/{en,tr}.json`. `src/i18n/paraglide/` is generated; never edit it.

## Add a message

1. Add the key to `messages/en.json` **and** `messages/tr.json` (snake_case, grouped by
   area, e.g. `outline_empty_title`). A unit test fails when the catalogs differ.
2. Use it: `import { m } from '../i18n';` then `m.outline_empty_title()`. Inputs are
   typed: `m.pages_count({ count })`. Vite recompiles on save; for `tsc` alone run
   `pnpm --filter @pdf-editor/web i18n`.
3. Call messages at render or run time, never in module-level constants (the language can
   change at runtime). For static tables store the function: `{ label: m.view_pages }`.

## Plurals

English uses a plural variant; Turkish does not inflect nouns after numbers, so a plain
string is enough:

```json
"pages_count": [{
  "declarations": ["input count", "local countPlural = count: plural"],
  "selectors": ["countPlural"],
  "match": { "countPlural=one": "{count} page", "countPlural=*": "{count} pages" }
}]
```

```json
"pages_count": "{count} sayfa"
```

## Turkish style

Concise, professional software Turkish: infinitive-free imperatives for actions
("Dosya aç", "Sayfaları düzenle"), sentence case, “…” quotation marks, `…` ellipsis,
percent sign before the number (%125, via `formatPercent`).

## Locale

`?lang=tr` overrides for one visit; the palette's Language commands switch at runtime and
persist. Numbers and dates use `formatNumber` / `formatPercent` / `Intl` with `getLocale()`.
