# Fonts

Noto Sans JP — notofonts/noto-cjk Sans 2.004 official release (SIL Open Font License 1.1)

- Source: https://github.com/notofonts/noto-cjk/releases/tag/Sans2.004 (`16_NotoSansJP.zip`)
- License: see `LICENSE.txt` (SIL OFL 1.1)
- Files:
  - `NotoSansJP-Regular.otf` — body text (fontWeight 400)
  - `NotoSansJP-Bold.otf` — emphasis / headings (fontWeight 700)

Used by `services/api/src/services/progress-pdf-document.tsx` for Japanese rendering in PDF output.

## Why static OTF instead of Variable Font

`@react-pdf/font` does not implement Variable Font weight axis interpolation
(`getVariation()` throws `Method not implemented.`). When registering a single
Variable TTF/OTF under multiple `fontWeight` keys, the file is loaded as a
static font with its **default axis values** — for `NotoSansJP-VariableFont.ttf`
that default is `wght=Thin (100)`, so every text node was rendered in Thin
regardless of the `fontWeight` specified.

Registering separate static OTF files for each weight bypasses this limitation.
