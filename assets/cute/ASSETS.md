# Illustration assets

Illustration assets for this project. The pocket logo was supplied directly by the user; ingredient illustrations were generated with the built-in `image_gen` tool. Initial source images are backed up outside the mini-program package in the workspace's `output/cute-assets-original/` directory. The 2026-10-23 delivery used proportional `sips` resizing without composition or color edits during resizing. The current packaged files also include the palette compression recorded below.

## 账号固定随机头像与当前图片预算（2026-10-30）

用户提供的五款碗插画用于账号头像：`avatar-broccoli.png`（西兰花玉米）、`avatar-pea.png`（豌豆萝卜）、`pantry-bowl.png`（蘑菇南瓜）、`avatar-eggplant.png`（茄子青菜）和 `pocket-mascot.png`（原品牌胡萝卜番茄）。前三个新头像文件中的西兰花、豌豆与茄子分别来自 Downloads/pocket/ 内的 `14_05_31-1`、`14_05_35-4`、`14_05_33-2` PNG。头像由稳定公开账号 ID 映射，五个位置和图片含义应保持不变，避免老账号随版本更换头像。品牌与功能入口继续使用各自固定插画。

新增三款头像采用 **224 × 224** 透明 PNG；既有品牌 logo **384 × 384**、问号碗 **320 × 320** 和南瓜碗 **360 × 360** 的宽高不变。全部从压缩前源图等比例输出，PNG 调色板 quality 80（南瓜碗 75）、dither 0.5、effort 10、compression 9；仅作显示资源压缩，没有重绘或裁切。两张食材图集逐字节保持不变。八张本地 PNG 当前总计 **198,566 B**（193.9 KiB），小于 200,000 B。这是有损调色板量化，已按界面显示尺寸对照检查边缘与颜色，不宣称像素完全相同。

源图、压缩前文件、可复现转换脚本、各文件大小及 SHA-256 见 [头像素材记录](../../../output/random-avatars/asset-report.json)，上下两排分别为源图和成品的[显示尺寸对照](../../../output/random-avatars/comparison.png)。下方各次压缩数据保留为历史记录。

## 按食材找菜专用图初次接入（2026-10-30，历史）

`pantry-bowl.png` 使用用户提供的蘑菇、南瓜和笑脸碗，替换首页“按食材找菜”入口与选材页顶部插画。原文件位于 `/Users/gaoya/Downloads/pocket/ChatGPT 图像 2026年10月30日 14_05_34-3.png`；用户消息中的上级路径已移动到 `pocket/`，已核对实际图像一致。

原图 1254 × 1254、1,030,117 B，等比例缩为 360 × 360，并沿用 256 色透明 PNG 调色板压缩，成品 **40,737 B**；保持完整构图，没有裁切或重绘。五张本地 PNG 合计 **198,472 B**（193.8 KiB），小于 200,000 B。既有品牌头像、问号碗及两张食材图集的字节均未改动。原图、候选文件、转换脚本和 SHA-256 明细见[素材归档](../../../output/pantry-mascot/asset-report.json)。

## 前四张本地插画压缩记录（2026-10-30）

Logo、问号碗和两张食材图集继续随小程序本地打包。采用 256 色 PNG 调色板量化（quality 100、dither 1、effort 10、compression 9），四张合计 **538,330 → 157,735 B**，减少约 **70.7%**，满足本地图片总计 `<200,000 B` 的预算。保留透明 PNG、原宽高、图集网格顺序及裁切坐标，没有缩放、裁切或重绘；量化会改变部分像素颜色，不是数学无损压缩，也不宣称像素或 alpha 数值逐点不变。微信开发者工具 2026/10/30 10:49 官方重新扫描显示「小程序表现良好，未发现代码质量问题」。本地原生编译、52 项相关测试及 4 张 PNG 实际解码/字节/MD5 检查均通过；首页、全部 19 种食材、随机页已目视检查。验收见 [汇总](../../../output/local-artwork-compression/verification.json)、[运行时报告](../../../output/local-artwork-compression/runtime-qa.json)与[官方扫描记录](../../../output/local-artwork-compression/official-quality-scan.json)。

| 文件 | 尺寸 | 压缩前 | 当时成品 |
| --- | --- | ---: | ---: |
| `ingredients-extra-sprite.png` | 450 × 600 | 138,740 B | 32,643 B |
| `ingredients-sprite.png` | 640 × 640 | 194,975 B | 52,192 B |
| `pocket-mascot.png` | 384 × 384 | 106,629 B | 36,473 B |
| `random-bowl.png` | 320 × 320 | 97,986 B | 36,427 B |

[应用明细与文件哈希](../../../output/local-artwork-compression/applied.json)、[原尺寸对照](../../../output/local-artwork-compression/comparison-full-size.png)、[Logo 与问号碗对照](../../../output/local-artwork-compression/comparison-logo-and-bowl.png)已归档。压缩前的四张文件保存在 [source](../../../output/local-artwork-compression/source/)，可恢复；[候选文件](../../../output/local-artwork-compression/candidates/)、[候选统计](../../../output/local-artwork-compression/compression-candidates.json)、[像素比较](../../../output/local-artwork-compression/pixel-comparison.json)和[压缩脚本](../../../output/local-artwork-compression/compress.cjs)均位于小程序目录外。下方来源、初始尺寸处理与旧压缩记录保留为历史。

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

## 初始交付尺寸与历史压缩

为满足小程序主包限制，成品图经过等比例编码优化：口袋角色 384×384，食材图集 640×640；均保留透明，未改变画面内容。原始生成文件保存在工作区 `output/cute-assets-original/`。食材图集按三等分计算，不依赖整数像素裁切。

**2026-10-29 历史无损压缩**：当时仅对 `ingredients-sprite.png` 的原始 PNG IDAT 数据流重新进行无损 Deflate 压缩，232,529 B → 194,975 B，满足单个资源不超过 200 K 的代码质量建议。未重采样、未改像素、未更换食材插画；解压后的图像数据完全相同，其 SHA-256 为 `539d3febf2a6a3361b2a56fc9e572dddbdfd6d162c93835eb6e871841a49264b`，全部非 IDAT 块（含颜色元信息）原样保留。优化后的文件 SHA-256 为 `aec2e8c0a41cbe6541496d1f27d0e0f14829359315b10149a1825209f3ad6512`；压缩前文件及核对结果保存在工作区 `output/code-quality/`。

## ingredients-extra-sprite.png

2026-10-23 使用内置 `image_gen`，以用户提供的十种食材插画为参考，生成透明食材图集；文字、卡片与标签由页面显示。没有使用 CLI/API 备用生成模式。

3 列 × 4 行：番茄 / 菠菜 / 山药；牛肉 / 三文鱼 / 大米；面粉 / 红枣 / 香蕉；燕麦 / 空 / 空。旧九种食材仍使用原图集。原图 1086×1448，保留 alpha，仅用 sips 等比例缩小到 450×600 供小程序使用；原始画稿位于 `output/cute-assets-original/ingredients-extra-sprite.png`。

生成提示词：

Use case: background-extraction and production sprite-sheet preparation. Edit the attached ingredient reference image into ONE transparent PNG sprite atlas for a Chinese baby-food mini-program. Image 1 is the exact target: retain its ten illustrated ingredients and their warm hand-drawn chocolate-brown outlines, attractive simple food shapes and colors. Image 2 is supporting style reference from the app's existing ingredient sprite sheet, not an edit target. Remove ALL Chinese labels, cards, borders and cream backgrounds. Output a PORTRAIT canvas with exact 3:4 aspect ratio, divided invisibly into 3 equal columns and 4 equal rows of square cells. Exact row-major positions: row 1 tomato / spinach leaves / cut Chinese yam; row 2 beef steak / salmon fillet / cream bowl of white rice with distinct individual grains; row 3 cream bowl of fine white flour with a smooth powder mound / two red jujube dates / one yellow banana; row 4 cream bowl of golden oat flakes / EMPTY / EMPTY. Exactly ten objects, last two cells fully empty. Center each ingredient independently in its own square cell, entirely within the central 65% width and height of the cell, with generous transparent gutters on all sides. Normalize their optical scale. No icon may cross a cell boundary. Rice, flour and oats must be visibly distinct by contents. Preserve the reference's friendly illustrated appearance, consistent brown line weights and warm food colors, no faces or new decorations. CRITICAL: the entire background and all gutters must be truly alpha-transparent. No checkerboard rendering, no shadows, no text, no labels, no badge, no outlines around cells, no extra icons. Deliver the production-ready transparent sprite atlas.

留白与尺寸调整提示词：

Edit only the scale and position of the ten food illustrations on this transparent sprite atlas. Preserve all ten objects, colors, drawing style and their exact existing row/column order. KEEP A PORTRAIT 3:4 CANVAS, exactly 3 equal columns and 4 equal rows of square cells. Critical: shrink EACH icon to 75% of its current size, then center it precisely at the center of its own square cell. Every icon must fit entirely inside the central 65% width and height of its own cell, all around broad transparent margins; ensure the top row is vertically centered rather than low in its cells. Row 1 tomato / spinach / yam; row 2 beef / salmon / rice; row 3 flour / dates / banana; row 4 oats / empty / empty. Do not draw labels, outlines of cells, cards, backgrounds, new ingredients or shadows. Preserve genuine alpha transparency outside the illustrations. Return one production-ready transparent PNG.

最终生成源：`/Users/gaoya/.codex/generated_images/01a15d55-74f7-7880-ade5-37e9001bc5fb/exec-6bf225da-fe56-4321-950e-ef14328a9e6e.png`。

## random-bowl.png

2026-10-29 用户提供「卖萌疑惑问号碗.png」，用于首页随机选餐入口和随机选餐页。保持原画面与透明背景，只用 `sips` 等比例缩至 320×320 以控制小程序包体；未重绘、未修改构图或颜色。原文件备份在 `output/entry-redesign/source/random-bowl-user.png`（1254×1254），来源 `/Users/gaoya/Downloads/卖萌疑惑问号碗.png`。现有 pocket-mascot 与食材图集保持不变。
