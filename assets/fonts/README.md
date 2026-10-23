# Pocket Brush title font

`pocket-brush.js` exports `family: 'PocketBrush'`, `base64`, and a complete `dataUrl` for the subset WOFF. It is intended for short illustrated headings and recipe names. Ordinary text and any unsupported user-entered characters should retain a system-font fallback.

Example source for `wx.loadFontFace`: `'url("' + font.dataUrl + '")'`. This asset file does not itself load or apply the font.

The font is a subset of **Ma Shan Zheng** from the official Google Fonts repository, downloaded 2026-10-23:

- Font: https://github.com/google/fonts/blob/main/ofl/mashanzheng/MaShanZheng-Regular.ttf
- License: https://github.com/google/fonts/blob/main/ofl/mashanzheng/OFL.txt
- Upstream project: https://github.com/googlefonts/mashanzheng

Copyright 2018 The Ma Shan Zheng Project Authors. Licensed under the SIL Open Font License 1.1; the full license is preserved in `OFL.txt`.

The subset uses the project UI text and seed recipe names, plus the supplied design's headings and basic punctuation/digits. The derivative's internal family name was changed to Pocket Brush. The original font, generated WOFF, character manifest and rebuild script are outside the mini-program package in `output/cute-assets-original/` at the workspace root. Rebuild with FontTools when adding new headings. FontTools 4.67.0 was used for this subset.
