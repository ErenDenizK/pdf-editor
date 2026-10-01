#!/usr/bin/env bash
# Builds the GitHub Release notes for one version (ADR-0017 §3, docs/specs/presentation.md §5)
# from the template .github/release-notes.md and the CHANGELOG sections that Changesets wrote
# for that version. Prints the notes on stdout.
#
#   .github/scripts/release-notes.sh <version> <dist zip name> <dist zip sha256> <run url> <commit>
#
# Added, Changed and Fixed come from the `## <version>` section of the web, engine and
# document-model CHANGELOGs, merged and without duplicates (a changeset that touches several
# packages appears in each). An entry whose text starts with "Added:", "Changed:" or "Fixed:"
# goes to that section, without the prefix; otherwise Major and Minor Changes go to Added and
# Patch Changes to Fixed. "Updated dependencies" entries are dropped. Highlights and Known
# limitations are written by hand in the template, whose `<!-- version: … -->` line must
# name this version, so stale highlights cannot ship.
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <version> <dist zip name> <dist zip sha256> <run url> <commit>" >&2
  exit 2
fi
version=$1 dist_zip=$2 dist_sha256=$3 run_url=$4 commit=$5

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
template="$root/.github/release-notes.md"
changelogs=()
for package in apps/web packages/engine packages/document-model; do
  if [[ -f "$root/$package/CHANGELOG.md" ]]; then changelogs+=("$root/$package/CHANGELOG.md"); fi
done

if ! grep -qxF "<!-- version: $version -->" "$template"; then
  echo "error: .github/release-notes.md is not written for $version." >&2
  echo "Set its first line to '<!-- version: $version -->' and update Highlights and Known limitations." >&2
  exit 1
fi
if [[ ${#changelogs[@]} -eq 0 ]]; then
  echo "error: no CHANGELOG.md found; run 'pnpm changeset version' first." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# One pass over the CHANGELOG sections: each entry (a "- " line and its indented
# continuation lines) is written to added.md, changed.md or fixed.md.
awk -v version="$version" -v out="$work" '
  function flush(   text, target, key) {
    if (entry == "") return
    text = entry
    entry = ""
    if (text ~ /^- Updated dependencies/) return
    # Changesets prefixes the commit: "- 1a2b3c4: text".
    sub(/^- [0-9a-f]+: /, "- ", text)
    target = (kind == "patch") ? "fixed" : "added"
    if (match(text, /^- (Added|Changed|Fixed): /)) {
      target = tolower(substr(text, 3, RLENGTH - 4))
      text = "- " substr(text, RLENGTH + 1)
    }
    key = text
    if (key in seen) return
    seen[key] = 1
    print text > (out "/" target ".md")
  }
  FNR == 1 { flush(); inside = 0; kind = "" }
  /^## / {
    flush()
    inside = ($0 == "## " version)
    next
  }
  !inside { next }
  /^### Major Changes/ { flush(); kind = "major"; next }
  /^### Minor Changes/ { flush(); kind = "minor"; next }
  /^### Patch Changes/ { flush(); kind = "patch"; next }
  /^- / { flush(); entry = $0; next }
  /^  / { if (entry != "") entry = entry "\n" $0; next }
  /^$/ { next }
  { flush() }
  END { flush() }
' "${changelogs[@]}"

for section in added changed fixed; do
  if [[ ! -s "$work/$section.md" ]]; then
    echo "Nothing in this release." > "$work/$section.md"
  fi
done

# Fill the template: whole-line comments dropped, {{added}} {{changed}} {{fixed}} replaced
# by the sections, the other fields by their values.
awk -v dir="$work" \
  -v version="$version" -v dist_zip="$dist_zip" -v dist_sha256="$dist_sha256" \
  -v run_url="$run_url" -v commit="$commit" '
  function fill(line, field, value,   at) {
    while ((at = index(line, "{{" field "}}")) > 0) {
      line = substr(line, 1, at - 1) value substr(line, at + length(field) + 4)
    }
    return line
  }
  /^[[:space:]]*<!--.*-->[[:space:]]*$/ { next }
  /^\{\{(added|changed|fixed)\}\}$/ {
    file = dir "/" substr($0, 3, length($0) - 4) ".md"
    while ((getline line < file) > 0) print line
    close(file)
    next
  }
  {
    line = fill($0, "version", version)
    line = fill(line, "dist_zip", dist_zip)
    line = fill(line, "dist_sha256", dist_sha256)
    line = fill(line, "run_url", run_url)
    line = fill(line, "commit", commit)
    print line
  }
' "$template" | cat -s | sed -e '/./,$!d'
