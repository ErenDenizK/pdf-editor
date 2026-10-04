# Bundled fonts

Fonts embedded by the assembler in page furniture (page numbers, headers and footers,
Bates numbers, watermarks) and served to the app for the live preview, and the faces the
paragraph editor sets characters in when a document's own font lacks them. All are licensed
under the **SIL Open Font License, Version 1.1** (full text in [`OFL.txt`](./OFL.txt)); none
declares a Reserved Font Name.

| File | Family, style | Upstream version | Copyright |
| --- | --- | --- | --- |
| `Inter-Regular.ttf` | Inter Regular | 4.001 | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| `Inter-Bold.ttf` | Inter Bold | 4.001 | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| `JetBrainsMono-Regular.ttf` | JetBrains Mono Regular | 2.211 | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| `NotoSerif-Regular.ttf` | Noto Serif Regular | 2.015 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) |
| `NotoSerif-Bold.ttf` | Noto Serif Bold | 2.015 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) |
| `NotoSans-Regular.ttf` | Noto Sans Regular | 2.015 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) |

## Provenance and modification

The static TTFs are the Google Fonts builds as published on npm by
`@expo-google-fonts/inter@0.4.2`, `@expo-google-fonts/jetbrains-mono@0.4.1`,
`@expo-google-fonts/noto-serif@0.4.2` and `@expo-google-fonts/noto-sans@0.4.2`
(`400Regular/NotoSans_400Regular.ttf`). They were subset with fontTools (`pyftsubset`) to
keep the repository small (about 1.2 MB for all six). Inter, JetBrains Mono and Noto Serif:

```sh
pyftsubset <font>.ttf --no-hinting --name-IDs=0,1,2,3,4,5,6,7,8,9,11,12,13,14 \
  --unicodes="U+0020-007E,U+00A0-024F,U+0259,U+02B0-02FF,U+0300-036F,U+0370-03FF,\
U+0400-052F,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-218F,U+2190-21FF,U+2200-22FF,\
U+25A0-25FF,U+FB00-FB06,U+FFFD"
```

That is Basic Latin, Latin-1, Latin Extended A/B and Additional (Turkish, Vietnamese, …),
Greek, Cyrillic (with Supplement), punctuation, currency, letterlike symbols, number
forms, arrows, mathematical operators and geometric shapes.

Noto Sans (added for the paragraph editor, whose sans substitute it is) keeps a wider
repertoire, since covering what Inter lacks is its purpose: the same ranges plus IPA
(U+0250–02AF), combining marks extended and supplement, Cyrillic Extended A–C, phonetic
extensions, Greek Extended, superscripts and subscripts, Latin Extended C–E and supplemental
punctuation (fontTools 4.66.1; 329 KB):

```sh
pyftsubset NotoSans_400Regular.ttf --no-hinting \
  --name-IDs=0,1,2,3,4,5,6,7,8,9,11,12,13,14 --output-file=NotoSans-Regular.ttf \
  --unicodes="U+0020-007E,U+00A0-024F,U+0250-02AF,U+02B0-02FF,U+0300-036F,U+0370-03FF,\
U+0400-052F,U+1AB0-1AFF,U+1C80-1C8F,U+1D00-1DFF,U+1E00-1EFF,U+1F00-1FFF,U+2000-206F,\
U+2070-209F,U+20A0-20CF,U+2100-218F,U+2190-21FF,U+2200-22FF,U+25A0-25FF,U+2C60-2C7F,\
U+2DE0-2DFF,U+2E00-2E7F,U+A640-A69F,U+A720-A7FF,U+AB30-AB6F,U+FB00-FB06,U+FFFD"
```

Running the first command on `@expo-google-fonts/noto-serif@0.4.2`'s regular file with
fontTools 4.66.1 gives a file byte-identical to `NotoSerif-Regular.ttf` here.

Hinting was removed; outlines, metrics, kerning and layout features are unchanged. The
copyright and license entries of the `name` table are preserved. These modified versions remain under the OFL 1.1.

Exports embed a further subset holding only the glyphs a document uses (pdf-lib with
`@cantoo/fontkit`); the OFL does not restrict documents created with the fonts.

Not bundled: italic files (italic is synthesized by a 12° skew), JetBrains Mono Bold
(bold is synthesized by stroking the glyph outlines) and Noto Sans Bold (a bold sans font's
missing characters go to Inter Bold first; together the six files must stay under 1.5 MB).
