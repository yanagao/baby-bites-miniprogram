# Illustration assets

Illustration assets for this project, 2026-10-23. The current pocket logo was supplied directly by the user; ingredient illustrations were generated with the built-in `image_gen` tool. Original alpha transparency is preserved. Source images are backed up outside the mini-program package in the workspace's `output/cute-assets-original/` directory. Packaged assets are proportionally resized with `sips` for package-size optimization only; no composition or color edits are made during resizing.

## pocket-mascot.png

2026-10-23 按用户要求替换为其提供的胡萝卜、番茄和眨眼口袋 logo。直接使用原图，不重新绘制；保留透明背景，等比例缩小至 384×384。首页、食材页、食谱页、记录页及随机选菜空状态共用此资源。

当前原图备份：`output/cute-assets-original/pocket-logo-user.png`（1254×1254）。用户来源文件：`codex-clipboard-8851f1cb-1832-4fbc-aad9-09f18cb5bf92.png`。

以下为已替换的旧角色生成记录，旧原图保留在 `output/cute-assets-original/pocket-mascot.png`。

Previous mascot prompt:

Use case: illustration-story. Asset type: transparent PNG mascot for a warm, cute Chinese baby-food recipe mini-program. Create ONE full-body hand-drawn cream-colored pocket mascot: a plump little fabric apron pocket with a gently curved bottom, dark chocolate brown hand-inked outline, lightly textured pale ivory filling, subtle warm-yellow stitched border, tiny black oval eyes, smiling mouth and rosy peach cheeks. Fresh leafy greens and a small carrot peek out from its open top. Tiny arms and short feet; one hand holds a wooden cooking spoon. Friendly and charming children's picture-book illustration, watercolor and colored pencil, simple shapes that remain clear at mobile UI scale. Center the mascot on a SQUARE genuinely transparent canvas. Fit the complete silhouette within central 86% of canvas, generous clear space around all sides. No backdrop, no scene, no text, no letters, no UI, no phone frame, no extra characters, no cast shadow, no border. Output a real alpha-transparent PNG.

Source: `/Users/gaoya/.codex/generated_images/01a1667c-3596-7b70-8603-e4b7c4fff7e7/exec-0fe3d083-2dc5-4fda-b08c-47ce8cc283fb.png`.

## ingredients-sprite.png

Prompt:

Use case: illustration-story. Asset type: a production sprite sheet of nine cute food ingredient illustrations for a Chinese baby-food mini-program. Generate ONE square PNG with a TRUE TRANSPARENT alpha background, exactly a 3 by 3 equally sized grid with NO visible grid lines. The canvas should be 900 x 900 pixels if possible; invisible cells are each 300 x 300. Put exactly one ingredient illustration centered in each cell, with each icon occupying about 60% of its cell width and height and generous transparent space so CSS can crop each equal cell without clipping. Exact row-major order: top left a friendly orange pumpkin with a tiny smiling face; top center a small cream ceramic bowl of golden yellow millet grains; top right one cream-colored whole egg. Middle left one pink boneless chicken breast; middle center one golden potato; middle right one broccoli floret. Bottom left an orange carrot with green leaves; bottom center a nest of light golden noodles; bottom right a small block of creamy white tofu. Consistent simple hand-drawn picture-book style, thick dark chocolate brown rounded outlines, minimal smooth flat pastel fills, a few hand-drawn highlight marks. Warm, sweet, appealing but not glossy 3D. All icons similar optical weight and scale. No labels, letters, numbers, text, borders, UI, badges, checkmarks, cards, background color, shadows, plate under the chicken, or additional decorative objects. Every pixel outside the ingredient silhouettes must be truly transparent. Do not render a checkerboard. Avoid complex photographic textures.

Source: `/Users/gaoya/.codex/generated_images/01a1667c-3596-7b70-8603-e4b7c4fff7e7/exec-4ff486f1-373b-45e4-acc5-d749004cda00.png`.

Grid order: pumpkin / millet bowl / egg; chicken / potato / broccoli; carrot / noodles / tofu.

Final sprite received a built-in image editing pass to reduce the individual illustrations and retain clear gutters for equal-cell CSS cropping. Final source: `/Users/gaoya/.codex/generated_images/01a1667c-3596-7b70-8603-e4b7c4fff7e7/exec-01a69666-ceb3-4ebe-93ef-2ea8f909e7cb.png`.

Edit prompt:

Edit this ingredient sprite sheet, preserving the same nine objects, their precise row-major order, their simple hand-drawn style, and true alpha transparency. CRITICAL CHANGE: reduce every ingredient illustration to 65% of its current size independently, and center it precisely inside its own one-ninth square. The canvas is divided into exactly three equal columns and three equal rows. Each object must fit entirely within the central 65% width and 65% height of its own cell. This leaves broad transparent gutters between every row and column and transparent padding at all outer edges. No object, including carrot leaves, may cross any cell border. Rows remain: pumpkin, millet bowl, egg / chicken breast, potato, broccoli / carrot, noodles, tofu. Retain smooth simple pastel colors, dark brown outlines. No visible grid, no text, no shadows, no white background, no checkerboard. Output genuine transparent PNG.

## 最终交付尺寸

为满足小程序主包限制，成品图经过等比例编码优化：口袋角色 384×384，食材图集 640×640；均保留透明，未改变画面内容。原始生成文件保存在工作区 `output/cute-assets-original/`。食材图集按三等分计算，不依赖整数像素裁切。

## ingredients-extra-sprite.png

2026-10-23 使用内置 `image_gen`，以用户提供的十种食材插画为参考，生成透明食材图集；文字、卡片与标签由页面显示。没有使用 CLI/API 备用生成模式。

3 列 × 4 行：番茄 / 菠菜 / 山药；牛肉 / 三文鱼 / 大米；面粉 / 红枣 / 香蕉；燕麦 / 空 / 空。旧九种食材仍使用原图集。原图 1086×1448，保留 alpha，仅用 sips 等比例缩小到 450×600 供小程序使用；原始画稿位于 `output/cute-assets-original/ingredients-extra-sprite.png`。

生成提示词：

Use case: background-extraction and production sprite-sheet preparation. Edit the attached ingredient reference image into ONE transparent PNG sprite atlas for a Chinese baby-food mini-program. Image 1 is the exact target: retain its ten illustrated ingredients and their warm hand-drawn chocolate-brown outlines, attractive simple food shapes and colors. Image 2 is supporting style reference from the app's existing ingredient sprite sheet, not an edit target. Remove ALL Chinese labels, cards, borders and cream backgrounds. Output a PORTRAIT canvas with exact 3:4 aspect ratio, divided invisibly into 3 equal columns and 4 equal rows of square cells. Exact row-major positions: row 1 tomato / spinach leaves / cut Chinese yam; row 2 beef steak / salmon fillet / cream bowl of white rice with distinct individual grains; row 3 cream bowl of fine white flour with a smooth powder mound / two red jujube dates / one yellow banana; row 4 cream bowl of golden oat flakes / EMPTY / EMPTY. Exactly ten objects, last two cells fully empty. Center each ingredient independently in its own square cell, entirely within the central 65% width and height of the cell, with generous transparent gutters on all sides. Normalize their optical scale. No icon may cross a cell boundary. Rice, flour and oats must be visibly distinct by contents. Preserve the reference's friendly illustrated appearance, consistent brown line weights and warm food colors, no faces or new decorations. CRITICAL: the entire background and all gutters must be truly alpha-transparent. No checkerboard rendering, no shadows, no text, no labels, no badge, no outlines around cells, no extra icons. Deliver the production-ready transparent sprite atlas.

留白与尺寸调整提示词：

Edit only the scale and position of the ten food illustrations on this transparent sprite atlas. Preserve all ten objects, colors, drawing style and their exact existing row/column order. KEEP A PORTRAIT 3:4 CANVAS, exactly 3 equal columns and 4 equal rows of square cells. Critical: shrink EACH icon to 75% of its current size, then center it precisely at the center of its own square cell. Every icon must fit entirely inside the central 65% width and height of its own cell, all around broad transparent margins; ensure the top row is vertically centered rather than low in its cells. Row 1 tomato / spinach / yam; row 2 beef / salmon / rice; row 3 flour / dates / banana; row 4 oats / empty / empty. Do not draw labels, outlines of cells, cards, backgrounds, new ingredients or shadows. Preserve genuine alpha transparency outside the illustrations. Return one production-ready transparent PNG.

最终生成源：`/Users/gaoya/.codex/generated_images/01a15d55-74f7-7880-ade5-37e9001bc5fb/exec-6bf225da-fe56-4321-950e-ef14328a9e6e.png`。
