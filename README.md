# 小口袋 · 微信小程序

版本 1.2.0。原生微信小程序，采用 JavaScript、WXML、WXSS 和腾讯 **TDesign MiniProgram 1.17.0**。正式 AppID：`wxc6c61fbebebe3340`；云环境：`cloud1-5gxmasdl05652531`。交付文件包含按需生成的 `miniprogram_npm/tdesign-miniprogram/`，首次导入无需安装 npm 依赖或重新构建。

## 打开与试用

1. 在微信开发者工具中登录有该 AppID 开发权限的微信。
2. 导入本文件夹 `baby-bites-miniprogram`，确认正式 AppID。使用现有云开发环境 `cloud1-5gxmasdl05652531`；无需新建环境或开通额外付费服务。
3. 点击「编译」检查模拟器；需要真机试用时，点击「预览」生成二维码，使用有权限的微信扫码。
4. 游客模式及旧测试号不能验收账号同步。工具若将 AppID 改为 `touristappid`，登录后需改回上面的正式 AppID 再预览。

项目已包含 `app.json` 和 `project.config.json`，不要导入网页版的 `dist` 目录。无需配置服务器域名。当前配置基础库为 3.7.12。

## 本轮设计（2026-10-23）

以用户提供的「可爱版 · 口袋小厨房」设计稿重构。该设计要求允许业务层使用自定义 WXSS、主题变量、页面留白和插画，替代此前仅用默认视觉的限制。采用奶油色背景、粉色操作按钮、浅绿色食材分组、口袋角色与食材插画；短标题使用 PocketBrush 字体，正文和未包含的用户输入字符保留系统字体回退。不使用 emoji 代替图标。

TDesign 仍负责 Navbar、TabBar、搜索、页签、开关、表单、选择器、弹层与确认对话框的交互。使用组件公开 API、插槽及样式变量，**不修改第三方组件源码、原始发布产物或官方图标字体**。页面视觉与业务组件放在本项目自己的 WXML/WXSS 中。

四个 Tab 依次为「今天 / 食材 / 食谱 / 记录」，选中项与真实路由同步。

## 已实现

- **今天**：以随机选菜为首页核心。首次进入自动随机选一道，呈现菜谱大图或食材插画、名称、时间、口感及“看看做法 / 再抽一道”。支持分类和跳过最近不太喜欢的菜，多候选时避免连续抽到同一道；返回保留有效结果，抽选不会自动新增用餐记录。空食谱保留添加入口，添加第一道后返回首页会自动选中。下方提供按食材找菜、最近吃过及设置入口。
- **食材**：九宫格展示南瓜、小米、鸡蛋、鸡肉、土豆、西兰花、胡萝卜、面条、豆腐。支持搜索、展开完整列表、添加其他食材；搜索或折叠不会丢失隐藏的已选项。匹配真实保存的菜谱，分为“食材已齐 / 再添一点”，明确列出缺少项；可只看食材齐全结果。
- **食谱**：照片小卡片展示菜名、时间、口感及最近喜好或食材。保留搜索、全部/收藏切换，以及折叠的分类、口感和排序筛选；添加入口可直接使用。列表只打开详情，收藏和记录操作进入详情后完成。
- **菜谱分类**：早餐饼、肉饼肉丸、面包糕点、粥饭主食、蔬菜手抓、蒸蛋豆腐、汤羹炖菜。首页支持横向滑动选择，列表和编辑表单共用同一套分类。旧版三类菜谱及备份在读取时兼容归类，保留原菜谱、收藏、照片和用餐记录，不因升级主动覆写本机数据；口感字段保持不变。
- **详情**：展示食材与用量、做法、备注及上次用餐反馈。收藏独立于宝宝喜好；底部“记一餐”新增记录，历史反馈入口编辑对应的旧记录，两种操作分开。保留菜谱编辑、照片及带确认的删除。
- **记录**：周日历按实际保存的 `date` 展示记录，日期切换、喜好筛选和周统计均来自真实数据。统计分别计算本周记录条数和尝过的不同菜谱数；不根据录入时间编造早餐、午餐或吃饭时刻。可选择菜谱为当前查看日期记一餐，也可编辑或删除已有记录。
- **数据**：本机缓存与当前微信账号云同步，包含宝宝称呼、菜谱、照片、收藏及用餐记录；保留备份文件导出/合并导入，可导入网页版导出的 JSON。正式环境已部署并启用，首次在新设备恢复需要网络。
- 默认内置 21 道示例菜谱，覆盖七种分类；新用户首次打开即可直接查看，无需导入，首次绑定微信账号、空云端同步和重启后仍显示 21 道，不生成用餐反馈。用户自行添加的菜谱在此之外累计，例如保留全部默认菜谱并添加 2 道后应为 23 道，不能用自加菜谱抵扣默认数量。既有账号不会因示例库更新被自动添加或恢复已删除菜谱；本次用户要求的补充通过明确合并导入完成。匹配的示例菜谱使用随包食物照片，用户自己的菜谱优先使用自己的照片，没有照片则显示食材插画。修改示例后变成自己的菜谱，不再套用示例照片。

2026-10-23 食谱扩充验收：默认 21 道与用户自加菜谱分别累计，例如自加 2 道后总数为 23 道。已验证补齐缺失默认菜谱时，已有菜谱、用餐记录、照片、收藏及删除记录保持不变；云端快照、列表总数和自加菜谱搜索均已核验。相关回归测试覆盖完整默认库与自加菜谱同时保留、补齐缺失默认菜谱、重复导入幂等及个人数据保护。新增做法按 [NHS 食物安全准备](https://www.nhs.uk/best-start-in-life/baby/weaning/safe-weaning/preparing-food-safely/) 和 [CDC 辅食制作原则](https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/when-what-and-how-to-introduce-solid-foods.html) 编写；具体配方为本项目示例，21 道是可选食谱数量，不是针对具体月龄的完整营养配餐方案。

## 数据与备份

同一微信账号在同一正式 AppID、同一云环境下，可以同步宝宝称呼、菜谱、照片、收藏及用餐记录。不同微信账号分别保存；不同 AppID、其他云环境及网页版不会自动合并，需要由用户导入备份迁移。同步不需要读取微信昵称、头像或手机号。

修改先保存到本机，再自动同步；进入前台、联网恢复和后续修改会触发同步，也可在「设置 → 微信账号同步」点击「立即同步」。状态分别显示未启用、等待同步、正在同步、已同步或未完成。换设备前确认已显示「已同步」，照片下载、备份导出及首次恢复仍需网络。

旧版本数据键 `baby-bites-v1` 继续保留。首次成功识别微信账号时，将未绑定的旧数据合并到该账号缓存，并记录迁移归属，防止再次合并给另一个账号。账号缓存使用 `baby-bites-account-<owner>`，当前缓存标识使用 `baby-bites-active-owner`；`owner` 是服务端从微信可信身份计算出的哈希，不由客户端自报。没有网络时保留最后一次确认账号的本机修改，未能确认的新账号不会上传旧账号数据。切换 AppID 后旧照片路径可能失效，迁移前须先导出含照片的备份。

多设备同步按条目 ID 合并，较新的 `updatedAt` 优先；同一条目的同时编辑不会逐字段拼接。明确导入本机已知删除的条目会作为恢复操作保留；相同版本的备份可修复已失效的本机照片，不替换有效照片或较新内容。删除会保留删除记录，避免另一设备的旧缓存把已删内容恢复；删除菜谱后，其对应的用餐记录也不会重新出现。云端以版本号事务提交，有冲突时先读取新版本、重新合并再提交，不直接覆盖其他设备的新内容。同步期间继续编辑的本机变化保留在下一次同步队列里。

菜谱更新、用餐记录新增及编辑都先校验后提交；存储失败时不更新内存。读取到损坏内容时保留原存储，普通编辑会被阻止，需导入有效备份恢复。记录编辑保留 `id` 和 `createdAt`，增加可选 `updatedAt`；旧备份缺失该字段时按 0 处理，合并时保留同一条记录较新的修改。

未同步照片使用微信持久文件路径；同步成功后使用属于当前账号的云端照片。导出时将本机或云端照片转换为嵌入图片的 JSON，导入时重新保存到当前设备。单张照片最多 2 MB，备份文件最多 20 MB，云端数据快照最多 5 MiB（照片独立存储，不嵌入快照）。

导出分两步：先生成备份文件，再点击「分享备份文件」（手机）或「保存到电脑」（桌面微信）。文件分享必须由新的点击直接触发，不能在照片异步读写完成后自动调用。取消、失败或离开待确认页面会清理临时备份；正在分享的文件等系统回调后再清理。导出不修改原有菜谱、照片和用餐记录。

开发者工具 2.02.2608080 / 基础库 3.7.12 实测可生成含照片的备份，但不支持 `shareFileMessage` 文件分享调试；需在手机微信完成分享验收，或手动使用「其他备份方式 → 复制备份内容」。

## 好友主页与公开食谱

「我的食谱」增加「我的主页」和「关注的菜谱」入口。用户单独设置公开昵称与简介，再通过微信原生分享把主页发给好友；好友可关注，查看关注的人公开的菜谱，并保存独立副本到自己的食谱。所有已有菜谱与新添加的副本默认私密，在个人菜谱详情中明确确认后才公开；收藏、宝宝资料、私人心得和用餐记录不公开。私下编辑不会自动更新公开版本，可主动更新或设为私密。

**暂时隐藏（2026-10-23，用户要求）**：保持 `config/cloud.js` 中 `socialEnabled: false`，并从 `app.json` 移除 `pages/profile/index`、`pages/following/index`、`pages/public-recipe/index` 的路由注册。主页、关注、公开菜谱入口均不显示，代码保留供以后恢复；私人菜谱、收藏、用餐记录与账号同步继续正常使用。重新开启须用户明确要求，恢复路由并完成下列云端配置与验收。

**云端配置已完成（2026-10-23）**：新函数 `babyBitesSocial` 与兼容来源字段的 `babyBitesSync` 已部署；三个社交集合已创建并设为客户端不可读写，公开食谱的两个非唯一复合索引已建立。真实只读 `mine`、`following`、`feed` 均成功，三个集合的客户端直读均被权限拒绝。社交入口仍保持隐藏；跨账号分享、公开照片下载与复制流程尚未进行真机验收。没有创建公开主页、公开现有私人菜谱或向好友发送消息。完整步骤见 [社交服务部署说明](cloudfunctions/babyBitesSocial/README.md)。

## 云同步配置与部署

云函数为 `cloudfunctions/babyBitesSync/`，固定使用 `wx-server-sdk@4.0.2`。数据库集合 `baby_bites_accounts` 只保存每个账号的版本号、快照 fileID 和更新时间；菜谱及记录快照位于 `users/<owner>/snapshots/`，照片位于 `users/<owner>/photos/`。该集合只允许管理端读写，云函数从可信微信上下文获取身份并校验文件归属。

客户端开关在 `config/cloud.js`。`env` 为空时不初始化或上传云端数据，只显示「云同步未启用」；完成权限配置及验证后才设置为 `cloud1-5gxmasdl05652531`。`project.config.json` 已使用正式 AppID 并声明 `cloudfunctionRoot`；云函数、规则文件及测试目录不打入小程序主包。

**已部署及验证（2026-10-23）**：`babyBitesSync` 已部署，`baby_bites_accounts` 集合设为客户端不可读写；原有存储权限已是仅创建者读写，保持不变。正式 AppID 下真实上传、再次同步、独立空缓存通过真实云接口恢复均通过，数据为 9 道菜谱、4 条用餐记录及 1 张照片；客户端直接读取账号集合被权限拒绝。214 项自动化测试及原生 WXML/WXSS 编译通过。独立缓存验证没有清空用户设备；仍需在两部手机及两个真实微信账号上补充端到端验收。

完整部署步骤、接口、快照限制及旧文件回收策略见 [云函数部署说明](cloudfunctions/babyBitesSync/README.md)。云端旧快照和照片暂不自动删除，避免破坏并发读取或离线设备的引用。

## TDesign 与重新构建

修改组件引用或重新生成依赖时，在本目录运行（需要 Node.js 和 npm）：

```sh
npm ci
npm run build:components
npm run validate
```

版本由 `package.json` 和 `package-lock.json` 固定为 1.17.0。构建器读取 `app.json`、`pages/`、`components/`、`custom-tab-bar/` 中的 `usingComponents`，收集实际使用的 TDesign 组件和递归依赖，保留共享 `common/`、所需内嵌 npm 依赖与 MIT LICENSE。每次仅重建 `miniprogram_npm/tdesign-miniprogram/`，不修改原始发布包或业务文件。新增组件后须重新运行构建。

官方「工具 → 构建 npm」会复制整个 `miniprogram_dist`。本项目基于同一发布产物按需复制，避免将全部组件、类型声明和开发元数据放入 2 MB 主包。不要额外导入 TDesign 总入口；组件在所需页面或组件 JSON 中单独声明。若官方 npm 构建覆盖了产物，再运行 `npm run build:components` 恢复按需版本。实际上传体积以开发者工具代码包分析为准。

按官方接入要求保持「将 JS 编译成 ES5」开启，不在 `app.json` 设置 `style: "v2"`。应验证目标最低基础库，不能将当前开发基础库的检查结果当作全部版本兼容保证。参阅 [TDesign 接入文档](https://tdesign.tencent.com/miniprogram/getting-started)。

## 验证状态

```sh
npm test
npm run validate
```

`validate.py` 跳过 `node_modules/`，检查页面声明、JSON、项目及已生成依赖的 JS/WXS 语法、组件路径、模板/样式导入和静态资源。本机有微信开发者工具时，批量调用其 WXML/WXSS 编译器；可用 `WECHAT_COMPILER_DIR` 指定包含 `wcc`、`wcsc` 的目录。无编译器时会明确提示未完成原生编译。此过程无需登录或启用服务端口。

账号同步新增测试覆盖账号隔离、旧数据一次性迁移、离线修改合并、删除记录、并发版本冲突、快照与照片路径校验、同步中继续编辑及存储失败保护。云端真实部署与多设备验收状态见上方「云同步配置与部署」；单元测试通过不代表真实云权限已生效。

以下为此前设计重构的历史验收记录，不代表当前用户数据数量或本次云同步验收结果：**80 项回归测试通过，9 页原生 WXML/WXSS 编译通过**。测试涵盖数据与备份、表单保存与取消、记录编辑和删除、随机结果稳定性、食材选中项保留与真实结果分组、日期和周日历、导航、字体加载及 TDesign 原始发布产物一致性。

**2026-10-23 新设计已通过原生编译及模拟器截图、点击验收。** 环境为 iPhone 15 Pro Max（430 × 932）、基础库 3.7.12。已检查四个 Tab 点击和返回状态、随机结果保留、食材选择与真实匹配、详情滚动及固定按钮、历史记录编辑、日期选择与指定日期下新增记录。修复滚动内容覆盖 Navbar、添加按钮对齐、历史喜好行误开新增记录及图标名称问题。80 项测试通过，9 页及 149 个 JS/WXS 文件校验通过；TDesign 厂商文件逐字节一致。

现有 8 道菜谱、3 条用餐记录在验收前后序列化内容完全一致；SHA-256 为 `f6623819cd6912f6cc42b56c71763414f0f86a074131a029d87e8e650351cd9f`。未保存测试记录或改变收藏，临时食材选择已清空。新版实际截图位于项目外 `output/visual-qa/cute-redesign/`，主索引为 `output/visual-qa/index.html`。旧截图与设计报告仍保留，但不代表本轮界面。

尚未完成本轮 iOS/Android 真机、窄屏及大字体模式验收，也未提交微信审核或发布。真机需单独验证相册/拍照、照片重启后显示、字体、键盘、底部安全区、导出文件、从聊天导入，以及清理微信后通过备份恢复。相册、相机与文件权限在实际调用时由用户决定；正式提审前按后台要求填写实际使用的隐私能力声明。

## 交互依据

交互继续参考 [Apple HIG](https://developer.apple.com/design/human-interface-guidelines)，通过小程序和 TDesign 的公开能力实现，不复制 iOS 系统控件外观。

- [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)：四个 Tab 稳定对应「今天 / 食材 / 食谱 / 记录」，选中状态来自真实路由。
- [Writing](https://developer.apple.com/design/human-interface-guidelines/writing) 与 [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)：操作写明结果；家长收藏、宝宝喜好、新增用餐和编辑历史分别表达。
- [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data) 与 [Pickers](https://developer.apple.com/design/human-interface-guidelines/pickers)：普通新增默认今天，从记录日历新增沿用选中日期；喜好不预选，食量选填，错误贴近字段。
- [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)：选中食材同时有勾与底色，收藏使用星标和文字；保存失败保留输入，防止重复提交。
- [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) 与 [Modality](https://developer.apple.com/design/human-interface-guidelines/modality)：丢弃修改、删除和合并导入需要确认，删除菜谱说明关联记录数量。
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)：导航保留文字，反馈不只依赖颜色，图标按钮提供中文名称；字号及读屏效果仍需真机检查。

此前调研参考 [Solid Starts](https://solidstarts.com/articles/solid-starts-app-new-first-100-foods/)、[Huckleberry Solids](https://huckleberrycare.com/product/solids)、[BLW Meals](https://blwmeals.com/)、[Paprika iOS 手册](https://www.paprikaapp.com/help/iphone/)、[SuperCook 开发者说明](https://apps.apple.com/us/app/supercook-recipe-by-ingredient/id1477747816) 与 [下厨房帮助中心](https://www.xiachufang.com/faq/)，用于区分菜谱、食材检索、收藏和每次用餐体验。这些是文档调研，不表示实测过各产品当前版本；随机选菜来自本项目自己的需求。

统一术语：宝宝反馈使用「不太喜欢 / 还不错 / 很喜欢」；家长偏好使用「收藏 / 已收藏」；用餐数据使用「用餐记录 / 用餐日期 / 食量」，食量可选「吃了一点 / 吃了约一半 / 吃了大部分 / 全部吃完」。

## 字体、图标与运行边界

TDesign 图标使用官方 0.4.5 字体原始字节，通过 `wx.loadFontFace` 离线加载。Base64 数据保存在 CommonJS `.js` 模块中，避免小程序无法直接加载 JSON 模块的问题。微信 API 定义从基础库 3.7.9 开始支持 Data URL；低版本或本地加载失败时回退官方 HTTPS 字体。原始图标字形和字体文件未修改，颜色与尺寸通过公开 API 设置。依据见 [微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts) 和 `assets/fonts/NOTICE.txt`。

PocketBrush 是 Ma Shan Zheng 的标题字符子集，使用独立字体名，通过微信字体 API 加载；包含的字符、字体来源与重建说明见 `assets/fonts/README.md`。加载失败或遇到子集未包含的字符时回退系统字体。口袋及食材插画的来源与处理记录见 `assets/cute/ASSETS.md`。

顶部使用 TDesign Navbar 和官方 `placeholder` 处理状态栏与微信胶囊；底部 TDesign TabBar 在四个 Tab 页正文末尾渲染，其 `placeholder` 参与页面布局。原生自定义导航宿主仅保留空壳，避免重复导航和占位失效。

未保存提醒仅在实际修改后启用。两个编辑页的返回及取消按钮使用放弃确认逻辑，微信 `enableAlertBeforeUnload` 作为系统返回的补充。微信文档不保证拦截侧滑返回，因此不声称所有退出方式都能恢复草稿。

## 文件结构

- `pages/`：四个 Tab 页及详情、菜谱编辑、记录编辑、独立随机、设置，共 9 页。
- `components/`：照片菜谱卡片、九宫格食材插画、底部导航等业务组件。
- `custom-tab-bar/`：空导航宿主，实际导航在四个 Tab 页内。
- `app.wxss`：本项目主题变量、正文与标题、通用布局样式。
- `miniprogram_npm/tdesign-miniprogram/`：随交付附带的按需组件产物，必须保留。
- `scripts/build-tdesign.cjs`：组件构建与依赖解析；`scripts/validate.py`：静态和原生编译检查。
- `utils/store.js`：校验和原子存储；`selectors.js`：筛选、匹配、图片与随机；`calendar.js`：日期与周统计；`backup.js`：含照片备份。
- `utils/cloud-sync.js`：云端同步调度及照片迁移；`utils/sync-merge.js`：合并与删除记录；`config/cloud.js`：云环境启用配置。
- `cloudfunctions/babyBitesSync/`：身份与版本提交云函数；`cloud/`：权限规则模板。共享环境必须按已有用途审查后应用模板。
- `data/recipes.js`：21 道示例菜谱，包含食材用量、步骤和口感说明。
- `assets/cute/`：口袋角色与食材插画；`assets/food/`：匹配示例菜谱的食物照片。
- `assets/fonts/`：TDesign 官方图标字体、PocketBrush 字体子集、来源和许可证。
- `tests/`：回归测试，不打入小程序包。

## 第三方许可与发布状态

TDesign MiniProgram 使用 MIT License，许可证保留在 `miniprogram_npm/tdesign-miniprogram/LICENSE`。发布包内嵌的运行时依赖按需原样复制，保留已有许可注释。`node_modules/` 不随交付打包，也不应提交到版本库；`miniprogram_npm/` 应随项目保留。

PocketBrush 基于 Ma Shan Zheng，使用 SIL Open Font License 1.1，完整许可证保留在 `assets/fonts/OFL.txt`。TDesign 官方图标字体许可保留在 `assets/fonts/LICENSE`。

本项目尚未提交微信审核或发布正式版；账号资料、类目、名称及隐私声明需要在微信后台配置。
