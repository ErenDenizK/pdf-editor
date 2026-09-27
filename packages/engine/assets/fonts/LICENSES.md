# Bundled fonts

Fonts embedded by the assembler in page furniture (page numbers, headers and footers,
Bates numbers, watermarks) and served to the app for the live preview. All are licensed
under the **SIL Open Font License, Version 1.1** (full text in [`OFL.txt`](./OFL.txt)); none
declares a Reserved Font Name.

| File | Family, style | Upstream version | Copyright |
| --- | --- | --- | --- |
| `Inter-Regular.ttf` | Inter Regular | 4.001 | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| `Inter-Bold.ttf` | Inter Bold | 4.001 | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| `JetBrainsMono-Regular.ttf` | JetBrains Mono Regular | 2.211 | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| `NotoSerif-Regular.ttf` | Noto Serif Regular | 2.015 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) |
| `NotoSerif-Bold.ttf` | Noto Serif Bold | 2.015 | Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) |

## Provenance and modification

The static TTFs are the Google Fonts builds as published on npm by
`@expo-google-fonts/inter@0.4.2`, `@expo-google-fonts/jetbrains-mono@0.4.1` and
`@expo-google-fonts/noto-serif@0.4.2`. They were subset with fontTools (`pyftsubset`) to
keep the repository small (about 0.9 MB for all five):

```sh
pyftsubset <font>.ttf --no-hinting --name-IDs=0,1,2,3,4,5,6,7,8,9,11,12,13,14 \
  --unicodes="U+0020-007E,U+00A0-024F,U+0259,U+02B0-02FF,U+0300-036F,U+0370-03FF,\
U+0400-052F,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-218F,U+2190-21FF,U+2200-22FF,\
U+25A0-25FF,U+FB00-FB06,U+FFFD"
```

That is Basic Latin, Latin-1, Latin Extended A/B and Additional (Turkish, Vietnamese, …),
Greek, Cyrillic (with Supplement), punctuation, currency, letterlike symbols, number
forms, arrows, mathematical operators and geometric shapes. Hinting was removed; outlines,
metrics, kerning and layout features are unchanged. The copyright and license entries of
the `name` table are preserved. These modified versions remain under the OFL 1.1.

Exports embed a further subset holding only the glyphs a document uses (pdf-lib with
`@cantoo/fontkit`); the OFL does not restrict documents created with the fonts.

Not bundled: italic files (italic is synthesized by a 12° skew) and JetBrains Mono Bold
(bold is synthesized by stroking the glyph outlines).
