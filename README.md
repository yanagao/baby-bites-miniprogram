# 小口袋 · 微信小程序

原生微信小程序，采用 JavaScript、WXML、WXSS 和腾讯 **TDesign MiniProgram 1.17.0**。AppID：`wx844feefcabeafbad`。交付文件已包含按需生成的 `miniprogram_npm/tdesign-miniprogram/`，首次导入无需安装 npm 依赖或重新构建。

## 打开与试用

1. 在微信开发者工具中登录有该 AppID 开发权限的微信。
2. 导入本文件夹 `baby-bites-miniprogram`，确认 AppID，并选择「不使用云服务」。
3. 点击「编译」检查模拟器；点击「预览」生成二维码，使用有权限的微信扫码。
4. 游客模式只能做本地调试。工具若将 AppID 自动改为 `touristappid`，登录后需改回上面的 AppID 再预览。

项目已包含 app.json 和 project.config.json，不要导入网页版的 dist 目录。无需配置服务器域名。

## TDesign 与重新构建

需要修改组件引用或重新生成依赖时，在本目录运行（需要 Node.js 和 npm）：

```sh
npm ci
npm run build:components
npm run validate
```

版本由 `package.json` 和 `package-lock.json` 固定为 1.17.0。构建器读取 `app.json`、`pages/`、`components/`、`custom-tab-bar/` 中的 `usingComponents`，收集实际使用的 TDesign 组件和递归依赖，保留共享 `common/`、所需内嵌 npm 依赖与 MIT LICENSE。每次仅重建 `miniprogram_npm/tdesign-miniprogram/`，不会修改原始发布包或业务文件。新增组件后须重新运行构建。

官方「工具 → 构建 npm」会复制整个 `miniprogram_dist`。本项目基于同一发布产物进行按需复制，避免将全部组件、类型声明和开发元数据放入 2 MB 主包。不要额外导入 TDesign 的总入口；组件应在需要的页面或组件 JSON 中单独声明。若使用官方 npm 构建覆盖了产物，再运行 `npm run build:components` 恢复按需版本。实际上传体积以开发者工具的代码包分析为准。

按官方接入要求保持「将 JS 编译成 ES5」开启，移除 `app.json` 的 `style: "v2"`。当前官方文档的最低基础库为 2.12.0；开发时应使用工具可正常运行的稳定基础库，并验证目标最低版本。主题通过 `app.wxss` 中的 `--td-*` 变量设置，不修改第三方组件源码。参阅 [TDesign 接入文档](https://tdesign.tencent.com/miniprogram/getting-started)。

## 已实现

- 首页：随机选餐、食材快捷入口、统计；统一浅蓝卡片，无首页食物大图、无 emoji。
- 菜谱：新增、编辑、删除、照片、搜索、分类、口感、排序、收藏。
- 喜好：三级反馈、日期、份量、备注，按最新一餐反馈计算喜好。
- 随机：按分类筛选、避开最近不喜欢的菜，在有多个候选时避免连续重复。
- 食材：多选与自定义食材、别名匹配、显示已备齐及缺失食材。
- 数据：微信本机存储、备份文件导出/合并导入，含照片；可导入网页版导出的 JSON。
- 首次有 8 道示例菜谱、0 条虚构反馈。修改示例后变成自己的菜谱。

## 数据说明

数据键为 `baby-bites-v1`，仅保存在当前微信/设备，不自动跨设备、跨微信账号或跨 AppID 同步。网页版和小程序数据也不会自动同步，可通过 JSON 备份迁移。

菜谱更新与记录写入先校验后提交；存储失败时不更新内存。读取到损坏内容时保留原存储，普通编辑会被阻止，需导入有效备份恢复。

照片使用微信持久文件路径；导出时转换为嵌入图片的 JSON，导入时重新保存到当前设备。单张照片最多 2 MB，备份文件最多 20 MB。

## 验证

```sh
npm test
npm run validate
```

`validate.py` 跳过 `node_modules/`，检查页面声明、JSON、项目及已生成依赖的 JS/WXS 语法、组件路径、模板/样式导入和静态资源。它在本机有微信开发者工具时批量调用内置 WXML/WXSS 编译器；可用 `WECHAT_COMPILER_DIR` 指定包含 `wcc`、`wcsc` 的目录。无编译器时会明确提示未完成原生编译。它不需要登录，不启用开发者工具服务端口。

当前 33 项回归测试通过，覆盖数据、备份、TDesign 选择事件及独立页面导航实例的切换、返回与失败重试。9 页及生成组件的原生 WXML/WXSS 编译通过。本轮微信开发者工具的窗口连接超时，尚未完成新组件界面的模拟器视觉检查；未生成真机预览二维码。每次调整页面或升级组件后应重新执行上面的验证，静态检查与模板编译不能替代模拟器及真机测试。

真机上需单独验证：选择相册/拍照、照片在重启后显示、导出文件与从聊天导入、清理微信后通过备份恢复。相册、相机与文件相关功能的微信权限由用户在调用时决定；正式提审前按后台要求填写实际使用的隐私能力声明。

## 文件结构

- `pages/`：四个 tab 页及详情、菜谱编辑、记录编辑、随机、设置，共 9 页。
- `components/`：图标、菜谱卡片、右下角加号按钮。
- `custom-tab-bar/`：基于 TDesign 的底部导航。
- `miniprogram_npm/tdesign-miniprogram/`：随交付附带的按需组件产物；必须保留。
- `scripts/build-tdesign.cjs`：组件构建与依赖解析；`scripts/validate.py`：静态和原生编译检查。
- `utils/store.js`：校验和原子存储；`selectors.js`：筛选、匹配和随机；`backup.js`：可迁移照片备份。
- `data/recipes.js`：示例菜谱。
- `assets/icons/`：线性 PNG 图标，适配原生小程序和 tabBar。
- `tests/`：数据与备份回归测试；不会打入小程序包。

本项目尚未提交微信审核或发布正式版；账号资料、类目、名称及隐私声明需要在微信后台配置。

## 第三方许可

TDesign MiniProgram 使用 MIT License；原始许可证随生成产物保留在 `miniprogram_npm/tdesign-miniprogram/LICENSE`。组件发布包内嵌的运行时依赖按需原样复制，保留其已有许可注释。`node_modules/` 不随交付打包，也不应提交到版本库；`miniprogram_npm/` 应随项目保留。
