# 菜谱示例照片

## 当前加载方式（2026-10-30）

按用户要求，默认菜谱配图改为云端加载，食材插画与 Logo 继续保留本地。21 张 JPEG 的原字节上传至现有云环境的 `public/recipe-covers/v1/<菜谱ID>-<内容哈希>.jpg`；上传不修改全局存储权限，不涉及用户照片或快照。只读 `babyBitesAssets` 云函数按固定清单签发短期 URL，不能按调用者提供的 fileID 或路径代理访问。

客户端以固定 `dish:<id>` 键查找，按已内置的字节数和 MD5 校验后缓存到独立静态目录 `USER_DATA_PATH/recipe-covers-v1/<sha256>.jpg`；缓存可供离线展示。缺失时后台最多 3 张并发下载，失败保留本地食材插画并允许下次进入前台重试。下载、缓存和更新只影响展示字段，不将 URL 或缓存文件写进用户菜谱的 `photo`、备份或云同步快照。

21 张 JPEG 原文件归档在工作区 [配图原文件目录](../../../output/cloud-recipe-covers/source/)，小程序包内不再包含 `recipe-media/food/`。下文 2026-10-29 分包验收记录为迁移前历史；当前清单见 [客户端元信息](../../data/recipe-cover-catalog.js)和[部署清单](../../cloudfunctions/babyBitesAssets/manifest.json)。

2026-10-30 微信开发者工具实际验收通过：目录请求及 21 张图片下载、缓存共约 4 秒；缓存字节数、MD5 和 600 × 400 解码全部正确。再次 `prepare()` 的 `catalogCalls` 与 `downloads` 均为 0，业务数据指纹前后不变，见 [验收报告](../../../output/cloud-recipe-covers/catalog-qa.json)。首页、食谱、详情、随机与食材页面的实际显示和状态保持检查也已通过，见 [界面验收](../../../output/cloud-recipe-covers/ui-qa.json)。这是开发者工具验收，尚不能替代真机与双账号验证。

## 生成来源与迁移前记录

21 道默认菜谱均有独立成品示意图，供首页、菜谱列表、详情、记录及公开分享页面展示。图片是生成的做法示意，不是用户上传的实拍。

保留原有 3 张 JPEG：`pumpkin.jpg`、`noodle.jpg`、`broccoli.jpg`。其来源为本项目早期网页版生成的本地素材 `baby-bites/dist/assets/pumpkin.png`、`noodle.png`、`broccoli.png`，原图继续保留，未重新生成。

2026-10-29 新增 18 张图片，使用内置 `image_gen` 为每道菜独立生成；提示词按 [默认菜谱](../../data/recipes.js) 的具体食材、做法和成品质地编写。统一采用 `photorealistic-natural` 风格：奶油白浅碗或盘、米色亚麻桌布、柔和窗光、3:2 横构图、居中且保留裁切余量，无文字、Logo、人物或无关装饰。手抓食物按做法切软条，白菜猪肉软丸呈现压碎后的食用状态。

新增原图为 1536 × 1024 PNG，保存在小程序目录外的 [原图目录](../../../output/recipe-photos/originals/)。完整提示词、生成源路径、最终原图路径和文件校验记录见 [第一批 9 张](../../../output/recipe-photos/batch-1.json)与[第二批 9 张](../../../output/recipe-photos/batch-2-prompts.json)。香蕉燕麦小饼的第一版未采用，第一批记录保留其提示词与源路径，最终版已调整为燕麦细粉形成的成品质地。

新增 18 张通过 macOS `sips` 等比缩小至 600 × 400，并以 JPEG 质量 45 编码，合计 **579,067 字节**；加上原有 3 张，21 张 JPEG 合计 **781,482 字节**。压缩文件与 PNG 原图分别保留。**2026-10-29 历史实现**曾将 JPEG 放在 `recipe-media/food/`，并通过 `require.async('../recipe-media/ready.js')` 加载资源分包；该图片加载方式已于 2026-10-30 由上方云端目录与独立缓存方案替代。本说明仍保留在 `assets/food/`。

**2026-10-29 迁移前历史验收**：官方开发者工具预览打包通过：主包 **1,879,199 字节**，图片资源分包 **781,594 字节**，总包 **2,660,793 字节**。开发者工具运行验收中，21 张图均成功解码为 600 × 400，食谱列表、默认菜谱详情、用户主页均已截图检查，操作前后私人业务数据摘要一致。结果见 [预览包信息](../../../output/recipe-photos/preview-info.json)和[界面验收记录](../../../output/recipe-photos/ui-qa.json)。

## 当前映射与数据边界

配图由 [客户端映射](../../utils/recipe-covers.js) 按准确的默认菜谱 `id`，或明确的 `imageKey: 'dish:<id>'` 选择；不会仅凭菜名、通用食材图标键或近似 ID 猜测。用户的 `photo` / `photoURL` 始终优先；没有自己的照片时，保留原始默认 ID 的菜谱可继续使用相应配图。普通自建菜谱不会因名字相同而套用默认成品图。

图片仅作为静态展示资源，不写入私人 `photo` 字段，不把图片文件嵌入私人快照或备份，也不作为用户照片上传。公开默认菜谱时，服务端使用明确的 `dish:<id>` 配图键；保存公开菜谱副本及再次公开时保留该键，由客户端读取已校验的缓存或仍有效的云端图片 URL。没有可用来源时继续显示食材插画，不等待其余图片下载。该键是 `imageKey` 元数据，不是照片文件、云文件 ID 或下载地址；作者或保存者自己的照片仍优先显示。

下表文件均归档在小程序包外的 [JPEG 原文件目录](../../../output/cloud-recipe-covers/source/)；每行公开配图键均为 `dish:` 加上该行完整菜谱 ID。

| 菜谱 ID | 菜名 | JPEG 文件 | 来源 |
| --- | --- | --- | --- |
| `pumpkin-millet` | 南瓜小米粥 | [pumpkin.jpg](../../../output/cloud-recipe-covers/source/pumpkin.jpg) | 原有素材 |
| `tomato-beef-noodle` | 番茄牛肉软面 | [noodle.jpg](../../../output/cloud-recipe-covers/source/noodle.jpg) | 原有素材 |
| `broccoli-potato` | 西兰花土豆泥 | [broccoli.jpg](../../../output/cloud-recipe-covers/source/broccoli.jpg) | 原有素材 |
| `carrot-chicken` | 胡萝卜鸡肉粥 | [carrot-chicken.jpg](../../../output/cloud-recipe-covers/source/carrot-chicken.jpg) | 第一批 |
| `yam-red-date` | 山药红枣泥 | [yam-red-date.jpg](../../../output/cloud-recipe-covers/source/yam-red-date.jpg) | 第一批 |
| `spinach-egg-pancake` | 菠菜鸡蛋小饼 | [spinach-egg-pancake.jpg](../../../output/cloud-recipe-covers/source/spinach-egg-pancake.jpg) | 第一批 |
| `salmon-vegetable` | 三文鱼蔬菜粥 | [salmon-vegetable.jpg](../../../output/cloud-recipe-covers/source/salmon-vegetable.jpg) | 第一批 |
| `banana-oat-pancake` | 香蕉燕麦小饼 | [banana-oat-pancake.jpg](../../../output/cloud-recipe-covers/source/banana-oat-pancake.jpg) | 第一批 |
| `chicken-tofu-patty` | 鸡肉豆腐软饼 | [chicken-tofu-patty.jpg](../../../output/cloud-recipe-covers/source/chicken-tofu-patty.jpg) | 第一批 |
| `carrot-beef-steamed-patty` | 胡萝卜牛肉蒸饼 | [carrot-beef-steamed-patty.jpg](../../../output/cloud-recipe-covers/source/carrot-beef-steamed-patty.jpg) | 第一批 |
| `cabbage-pork-soft-meatball` | 白菜猪肉软丸 | [cabbage-pork-soft-meatball.jpg](../../../output/cloud-recipe-covers/source/cabbage-pork-soft-meatball.jpg) | 第一批 |
| `pumpkin-oat-steamed-cake` | 南瓜燕麦蒸糕 | [pumpkin-oat-steamed-cake.jpg](../../../output/cloud-recipe-covers/source/pumpkin-oat-steamed-cake.jpg) | 第一批 |
| `apple-yam-steamed-cake` | 苹果山药蒸糕 | [apple-yam-steamed-cake.jpg](../../../output/cloud-recipe-covers/source/apple-yam-steamed-cake.jpg) | 第二批 |
| `sweet-potato-soft-bun` | 红薯小馒头 | [sweet-potato-soft-bun.jpg](../../../output/cloud-recipe-covers/source/sweet-potato-soft-bun.jpg) | 第二批 |
| `pumpkin-steamed-egg` | 南瓜鸡蛋羹 | [pumpkin-steamed-egg.jpg](../../../output/cloud-recipe-covers/source/pumpkin-steamed-egg.jpg) | 第二批 |
| `spinach-tofu-steamed-egg` | 菠菜豆腐蒸蛋 | [spinach-tofu-steamed-egg.jpg](../../../output/cloud-recipe-covers/source/spinach-tofu-steamed-egg.jpg) | 第二批 |
| `salmon-tofu-steamed-patty` | 三文鱼豆腐蒸饼 | [salmon-tofu-steamed-patty.jpg](../../../output/cloud-recipe-covers/source/salmon-tofu-steamed-patty.jpg) | 第二批 |
| `potato-beef-thick-soup` | 土豆牛肉浓汤 | [potato-beef-thick-soup.jpg](../../../output/cloud-recipe-covers/source/potato-beef-thick-soup.jpg) | 第二批 |
| `tomato-egg-tofu-soup` | 番茄鸡蛋豆腐羹 | [tomato-egg-tofu-soup.jpg](../../../output/cloud-recipe-covers/source/tomato-egg-tofu-soup.jpg) | 第二批 |
| `winter-melon-chicken-stew` | 冬瓜鸡肉炖菜 | [winter-melon-chicken-stew.jpg](../../../output/cloud-recipe-covers/source/winter-melon-chicken-stew.jpg) | 第二批 |
| `broccoli-carrot-soft-fingers` | 西兰花胡萝卜软条 | [broccoli-carrot-soft-fingers.jpg](../../../output/cloud-recipe-covers/source/broccoli-carrot-soft-fingers.jpg) | 第二批 |
