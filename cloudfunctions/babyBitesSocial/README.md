# 小口袋公开主页与关注

函数名 `babyBitesSocial`，AppID `wxc6c61fbebebe3340`，现有环境 `cloud1-5gxmasdl05652531`。本目录只提供可部署代码，不会自动创建主页、关注别人或公开现有菜谱。

**2026-10-23 历史配置验收**：当时的函数已部署，以下三个集合均已创建并设为“所有用户不可读写”。两个非唯一复合索引已在控制台核验，名称分别为 `profile_published_sort`、`profile_published_id`。真实只读 `mine`、`following`、`feed` 成功，尚无公开主页、公开菜谱或关注；客户端直接读取三个集合均返回权限拒绝 `-502003`。原有存储权限保持不变。当时按用户要求关闭社交入口，未进行真实发布、跨账号分享、照片下载及复制验收。

**2026-10-28 功能扩展与部署**：用户已要求启用账号主页、关注/回关和食谱分享。本次后端补充粉丝列表、双向关注状态及关注/粉丝/公开食谱数，保持原有集合和关注数据结构。新版 `babyBitesSocial` 已通过微信开发者工具 CLI 部署到现有环境，客户端 `socialEnabled: true` 及三个社交路由已恢复；新增粉丝查询非唯一复合索引 `followers_profile_id`（`profileIds ASC, _id ASC`）已在真实云控制台创建并从索引列表确认。本地后端 36 项测试通过，包含超过 1020 名粉丝的连续分页；尚未完成双手机、双微信账号端到端实测，也未提交微信审核或发布。

**同日只读验收**：已部署接口 `mine`、`following`、`followers`、`feed` 均成功，三个社交集合的客户端直接读取均被权限拒绝；私人缓存指纹及云同步 revision 8 在验收前后不变。首次只读请求曾触发原配置的 3 秒执行超时，重试全部通过；现已在控制台将 `babyBitesSocial` 执行超时调整为 30 秒，保存后重新打开配置确认生效。内存保持 256 MB，其他函数未改动；该配置问题已处理，不代表已完成双账号真机或大照片发布验收。

**同日发现与主页码部署**：新增 `discover` 公开发现与搜索，以及 `shareCode` 微信主页码，已通过微信开发者工具 CLI 部署成功（6 个文件，约 31 KB）。非唯一复合索引 `public_latest_sort`（`published ASC, sortKey ASC`）已在真实云控制台创建并从列表确认；`config.json` 中的 `wxacode.getUnlimited` 云调用权限已随函数部署，30 秒超时与 256 MB 内存已复核。本地后端 49 项、项目全量 415 项测试通过；15 页、183 个 JS/WXS 脚本校验及微信原生 WXML/WXSS 编译通过。

**2026-10-28 真实验收**：`discover` 最新列表和“南瓜”搜索真实云端请求成功，当前无公开菜谱，均返回 0 条且无后续游标；本人尚无公开主页时，`shareCode` 返回 `PROFILE_REQUIRED`，没有生成分享码或创建主页。前后 `mine` 均为 `profile.exists:false`，公开食谱、关注及粉丝数均为 0。原始缓存、业务数据、活动账号和云账号指纹均不变，revision 保持 8，24 道菜谱、6 条记录、1 道收藏保留，详见 [cloud-live.json](../../../output/reference-interactions/cloud-live.json)。客户端另完成 6 条真实点击流程、14 张截图，食材临时选择已恢复，见 [交互验收报告](../../../output/reference-interactions/reference-qa-report.json)。

**2026-10-29 宝宝月龄部署与验收**：公开主页新增可选 `babyAgeMonths`；新版函数已通过 CLI 部署成功（6 个文件，约 31.6 KB），部署后状态 Active、执行超时 30 秒、运行时 Node.js 16.13 已确认。再次登录云控制台被浏览器安全策略拒绝，已停止尝试，本次部署后的内存配置未复核。全量 494 项测试及 15 页、181 个 JS/WXS 脚本和原生 WXML/WXSS 编译通过。真实云端 `mine` 返回 `babyAgeMonths:null`、`profile.exists:false`；开发者工具点击月龄入口、打开编辑和原生滚轮后取消关闭，未保存。云端主页与本机业务数据指纹前后一致，未创建主页或写入用户数据，见 [编辑记录](../../../output/baby-age/editor.json)与[主页记录](../../../output/baby-age/mine.json)。

**同日默认昵称增量部署与验收**：第二次 CLI 部署成功（6 个文件，约 32.4 KB），部署后 CLI 确认状态 Active、执行超时 30 秒、运行时 Node.js 16.13。全量 500 项测试与 15 页、182 个 JS/WXS 脚本校验和原生 WXML/WXSS 编译通过。真实云端连续两次 `mine` 返回同一自动昵称“小胡萝卜4191”，本人主页显示同名且主按钮为“编辑资料”；`profile.exists:false`、`babyAgeMonths:null`。本机业务数据指纹与月龄验收前一致，未保存公开主页或写入用户资料，见 [默认昵称验收记录](../../../output/baby-age/nickname.json)与[主页截图](../../../output/baby-age/nickname-mine.png)。本次部署后的内存仍未复核。

**2026-10-29 默认配图增量部署历史验收（图片已改为云端加载）**：默认 21 道菜谱的准确配图键及旧公开记录读取兼容已随 `babyBitesSocial` CLI 部署成功（7 个文件，约 33.6 KB），不迁移或改写私人快照。全量 528 项测试、16 页（15 个业务页及资源 `anchor`）、189 个 JS/WXS 脚本校验和原生 WXML/WXSS 编译通过。客户端官方 `preview` 成功，总包 2,660,793 字节、主包 1,879,199 字节、`recipe-media` 分包 781,594 字节，未修改 `bigPackageSizeSupport`、Logo 或字体，见 [包体记录](../../../output/recipe-photos/preview-info.json)。真实 `wx.getImageInfo` 成功解码全部 21 张图为 600 × 400；食谱列表、默认菜谱详情及“我的”用户主页三屏截图验收通过。前后业务数据 SHA-256 均为 `e3fba67c2d94955b12f93e9004dd108914c308179fb8a28a77997a1f8e264291`，未写入用户资料，见 [只读验收报告](../../../output/recipe-photos/ui-qa.json)。

真实分享码生成与扫码、双手机双账号关注/回关、公开/设为私密、照片下载和保存副本仍待真机验收；空列表与前置校验成功不代表这些场景已实测。月龄保存后在另一账号主页展示的流程未使用用户账号写入测试。尚未提交微信审核或发布。

## 部署顺序

1. 保留原 `babyBitesSync`、`baby_bites_accounts` 和环境已有其他业务。创建三个新集合：`baby_bites_profiles`、`baby_bites_public_recipes`、`baby_bites_follows`。三个集合分别设置为所有客户端不可读写（`{"read":false,"write":false}`），仅云函数管理员 SDK 访问。不能把公开食谱集合直接设为所有人可读：它还含有发布人的内部账号标识、来源 ID 和私有文件指针。
2. 确认下列非唯一复合索引存在并已完成构建，字段顺序如下：

   | 集合 | 索引用途 | 字段及方向 |
   | --- | --- | --- |
   | `baby_bites_public_recipes` | 主页与关注动态 | `profileId ASC, published ASC, sortKey ASC` |
   | `baby_bites_public_recipes` | 本人公开状态清单 | `profileId ASC, published ASC, _id ASC` |
   | `baby_bites_public_recipes` | 全局最新公开列表与有界搜索，已建索引 `public_latest_sort` | `published ASC, sortKey ASC` |
   | `baby_bites_follows` | 粉丝列表与粉丝数，已建索引 `followers_profile_id` | `profileIds ASC, _id ASC` |

   主页集合仍按 `_id` 读取。关注集合每个账号仅一个文档，结构仍为 `{_id: owner, profileIds, updatedAt}`，最多 200 个主页 ID；无需批量迁移、补写旧记录或建立另一套粉丝数据。反向查询为 `where({profileIds: db.command.in([目标主页ID])})`，列表再按 `_id ASC` 排序；`count()` 统计匹配文档，不下载整张关注表。CloudBase [Node SDK 查询文档](https://docs.cloudbase.net/api-reference/server/node-sdk/database/fetch)提供数组字段 `_.in()`、计数及分页用法；组合索引的首字段可服务计数查询，规则见[索引管理](https://docs.cloudbase.net/database/data-index)。既有粉丝索引创建与只读接口验收已完成，本次新增 `public_latest_sort` 也已创建并列表确认；正式跨账号验收仍需覆盖有真实关注数据的粉丝分页与关系计数，不能仅凭本地模拟测试或空列表成功认定这些场景已实测。
3. **保留现有云存储的仅创建者读写权限，不新增公开目录通配规则。** 云函数复制用户明确公开的成品照到 `social/<profileId>/<publicRecipeId>/<unique>.jpg|png|webp`，文件由服务端管理。访客只能通过云函数取得当前仍公开照片的短期 HTTPS 签名地址。私人原图 `users/<owner>/photos/` 和同步快照保持原权限。
4. 云端安装本函数依赖，SDK 固定 `wx-server-sdk@4.0.2`；当前云端运行时为 **Node.js 16.13**，本函数与 `package.json` 的最低版本声明保持兼容。每次部署后复核本函数的实际运行配置；上方 30 秒超时与 256 MB 内存是既往已核验记录，不作为其他函数的部署要求。公开操作可能读取最大 5 MiB 同步快照并复制 2 MiB 照片，需结合实际验收确认耗时余量，不顺带修改其他函数。

   ```sh
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy --env cloud1-5gxmasdl05652531 --names babyBitesSocial --remote-npm-install --project PROJECT
   ```

   `PROJECT` 是小程序根目录的绝对路径。此命令不会公开菜谱。若本次同时给私人数据增加可选 `source` 来源字段，应一并更新并部署 `babyBitesSync` 的校验器，防止新复制的菜谱同步失败。`private-snapshot.js` 是供本函数独立部署的同格式校验器，格式修改时须同步维护。
5. 用户已授权启用相关功能；部署新版函数及新增索引后，先以只读 `mine`、`followers`、空主页确认函数连通、三集合拒绝客户端直读，再用独立测试账号/测试菜谱检查公开、关注、回关、互相关注、取消关注、复制和撤回。客户端 `config/cloud.js` 的 `socialEnabled` 及 `app.json` 中主页、关注、公开菜谱路由应与新版服务一起启用并重新编译验收。旧函数不支持 `followers` 或新计数字段，不能仅打开客户端开关作为上线完成。不要为验收自动公开用户已有私人菜谱，也不要发送真实微信好友消息。
6. 真机验证 `<image>` 加载和 `wx.downloadFile` 下载服务器返回的签名 URL。若真机提示下载域名未配置，在正式小程序管理后台配置实际存储域名的 `downloadFile` 合法域名；不要通过公开整个存储桶或关闭真机域名校验绕过。临时地址应在 300 秒后失效，页面重新显示时重新取数。体验版云环境有效期及额度以控制台为准。
7. 主页码需要同目录 `config.json` 声明 `permissions.openapi: ["wxacode.getUnlimited"]` 并随云函数上传；核对小程序与当前云环境已关联。先用当前实际可访问的 `develop` / `trial` 版本验证生成与扫码，正式主页发布后再验证 `release`。`checkPath:false` 只关闭开发/体验版的路径检查，不能让未发布的正式版凭空可访问；不要把开发码伪装成正式码。云调用权限问题参考 [CloudBase 官方说明](https://docs.cloudbase.net/faq/knowledge/cloud-call-604101-permission-error)，权限配置更新可能有缓存延迟。

## API

所有调用为 `wx.cloud.callFunction({name:'babyBitesSocial',data:{action,...}})`。微信身份只取 `cloud.getWXContext()`。内部 owner 是 `sha256(APPID + ':' + OPENID)`；传入 owner、openid 均不能指定另一账号。客户端每次确认私人同步身份后传 `expectedOwner`；如该前置条件不等于真实调用账号，任何读写前返回 `ACCOUNT_CHANGED`，避免异步切换账号时作用到另一人。

公开主页 ID 是 `sha256('public-profile:' + owner)` 的前 32 位十六进制。公开菜谱 ID 是 `sha256('public-recipe:' + owner + ':' + sourceRecipeId)`，64 位十六进制。它们不能用于直接下载任何私人文件。

| action | 参数 | 返回 |
| --- | --- | --- |
| `mine` | 无 | `{profile,published,publishedCount,followingCount,followerCount}` |
| `updateProfile` | `name,bio,babyBirthDate?`（兼容旧 `babyAgeMonths?`） | `{profile}` |
| `checkProfile` | 同 `updateProfile`，只校验与审核 | `{validated:true,saved:false}` |
| `profile` | `profileId,offset?` | `{profile,isSelf,following,followedBy,publishedCount,followingCount,followerCount,recipes,nextOffset}` |
| `recipe` | `recipeId` | `{recipe,author}` |
| `publish` | `sourceRecipeId` | `{recipe}` |
| `unpublish` | `sourceRecipeId` | `{ok:true}` |
| `follow` | `profileId,following:boolean` | `{following,followedBy}` |
| `following` | `offset?` | `{profiles,nextOffset}` |
| `followers` | `offset?` | `{profiles,nextOffset}` |
| `feed` | `cursor?` | `{recipes,nextCursor}` |
| `discover` | `search?:string,cursor?:string` | `{recipes,nextCursor}` |
| `shareCode` | `profileId,envVersion` | `{profileId,envVersion,codeURL}` |

公开 `profile` / `author` 为 `{id,name,bio,babyAgeMonths,exists}`。只有本人 `mine`、`updateProfile` 与 `profile` 且 `isSelf:true` 的 `profile` 额外包含 `babyBirthDate:string|null`；访客主页、所有菜谱作者 DTO（包括本人读取自己的菜谱）、关注及粉丝列表均不含生日。本人身份只根据云函数可信上下文判断，不能用请求中的 `isSelf`、`owner` 或 `profileId` 冒充。主页名字 1–20 字，简介最多 120 字，不接受控制字符。`mine` 在尚未建主页时返回稳定 ID、自动昵称、空简介、`babyAgeMonths:null`、`babyBirthDate:null`、`exists:false`，不会写入数据库，也不会把宝宝称呼用作公开名字。用户第一次保存主页后才建立公开资料。

默认昵称由 `sha256('public-default-name:' + owner)` 派生，为“小胡萝卜 / 小南瓜 / 小番茄 / 小土豆 / 小西兰花 / 小玉米”之一加 1000–9999 的四位数字。同一账号稳定，不保证全局唯一；名称不携带原始微信身份，不替换已有自定义名字，也不自动写入 `baby_bites_profiles`。本人主页直接显示此名称，主按钮统一为“编辑资料”。首次分享、公开菜谱及关注别人仍要求显式保存主页资料，可以直接保存自动昵称，无需手工取名；默认昵称自身不代表 `exists:true`。

`babyBirthDate` 是可选的严格 `YYYY-MM-DD` 日期字符串或 `null`。服务端拒绝错误类型、格式、无效日历日期、早于 `1900-01-01` 或晚于中国 UTC+8 当天的日期，返回 `INVALID_BABY_BIRTH_DATE`；不会把错误日期滚动为下个月。省略字段时，在事务内保留已有生日；明确传 `null` 同时清除生日和旧手动月龄。填写有效生日也会清除旧手动月龄，之后每次读取按生日和服务端中国日期计算已满月数，不把计算值写回数据库。月末生日在当月没有对应日时取该月最后一天，例如 `2025-01-31` 至 `2025-02-28` 为 1 个月，`2024-02-29` 至 `2025-02-28` 为 12 个月。生日计算结果不受旧手动输入的 120 个月上限限制。

旧 `babyAgeMonths` 输入继续接受 `null` 或 0–120 的整数，错误值返回 `INVALID_BABY_AGE`。没有生日的遗留资料继续显示原手动月龄，省略该字段时保留原值，传 `null` 清除；已有生日时始终优先按生日计算，旧客户端只改昵称、简介或旧月龄不会清除生日。若同一请求同时包含生日与旧月龄，生日字段优先处理，旧月龄存为 `null`。旧主页没有这两个字段时按 `null` 返回，无需回填或迁移；0 表示“未满1个月”，`null` 不展示。

生日只保存在禁止客户端直读写的 `baby_bites_profiles` 内部资料中，仅本人接口返回；公开的是动态月龄。生日不进入私人 snapshot、菜谱发布副本、关注记录或分享码参数。`baby-age.js` 与客户端 `utils/baby-age.js` 使用同一份中国日期、日期校验与月末算法；服务端使用可注入的 `now()` 测试跨日和生日边界。修改或清除在显式保存主页后生效，读取不会创建主页或修改现有资料。

`mine.published` 仅本人可见，条目为 `{id,sourceRecipeId,sourceUpdatedAt}`；修改时间取私人菜谱的 `updatedAt || createdAt || 0`。客户端以此判断是否需要重新公开更新。

`following` / `followers` 仅列出真实调用账号的关注/粉丝；传入 `owner`、`profileId` 不会切换为他人列表。每项只包含 `{id,name,bio,babyAgeMonths,exists,following,followedBy}`，其中 `following` 表示“我关注对方”，`followedBy` 表示“对方关注我”；两者都为 `true` 即互相关注，只有 `followedBy` 时可通过已有 `follow` 操作回关。`profile` 的关系布尔值同样相对于当前调用者，三个计数则属于被查看的主页；`publishedCount` 为总数，不是当前 20 条列表的长度。

新关注（包括对已关注关系再次传 `following:true`）必须先保存本人公开主页，否则返回 `PROFILE_REQUIRED`，不会替用户创建主页或取用宝宝称呼。取消关注不要求本人主页或目标主页仍存在，方便旧账号清理关系。关注操作在一个事务内读取本人关系、双方主页和对方反向关系，仅在状态发生改变时写本人文档；重复请求不重复添加，计数直接来自关系记录，无额外计数器漂移。

旧版本允许未设置公开主页的账号关注别人；这些关系保留并计入关系数，不自动替旧账号生成公开资料。粉丝列表跳过尚无有效公开主页的旧账号；本人以后保存主页时，该已有关系才以公开资料出现在列表中。因此历史关系可能造成计数高于当前可展示的主页数，页面应保留服务器提供的分页位置。缺失或损坏的主页不会暴露对应内部 owner 或私有资料。

公开菜谱白名单：`{id,profileId,authorName,name,category,minutes,texture,ingredients,steps,imageKey,photoURL,updatedAt,publishedAt}`，另可包含 `ageGroups`。月龄标签仅从已提交的私人快照读取，枚举为 `6-8 / 9-11 / 12-17 / 18+`；数组最多 4 项，校验后去重并按枚举排序。缺失字段保持省略，`[]` 表示明确清空；客户端将两者均解释为不限月龄，参与任意月龄的抽选，不需要补写全部标签。发布请求自行附带的标签不作为来源。保存副本时保留明确的标签，更新公开版本仍须用户主动操作。如果来自其他公开食谱，可带 `source:{profileId,recipeId,authorName}`。来源作者名由服务器真实记录解析，不能靠客户端伪造；原作者撤回公开后，已有副本和已保存的来源仍然保留。不会返回私人 note、favorite、宝宝称呼、用餐记录、内部 owner、来源私有菜谱 ID、云文件 ID。

`recipe-covers.js` 为 21 个准确默认菜谱 ID 映射 `imageKey: 'dish:<id>'`，不根据任意私人 ID、相似菜名或通用食材键推测。新公开默认菜谱时写入该公开配图键；旧公开记录在详情、主页、发现及关注动态读取时按内部已存的默认来源 ID 兼容补出键，不写回旧记录，也不暴露私人来源 ID。已有明确 `dish:<id>` 的保存副本再次公开时保留该键。作者自传照片仍单独通过 `photoURL` 返回并优先展示，配图键不会替代其照片。

配图包含原有 3 张及内置 `image_gen` 逐菜生成的 18 张，成品图与完整提示词来源见客户端 [资源说明](../../assets/food/ASSETS.md)。21 张 JPEG 现由独立的 [babyBitesAssets](../babyBitesAssets/README.md) 云函数按固定清单签发临时 URL；原文件归档在小程序包外的 [工作区目录](../../../output/cloud-recipe-covers/source/)，不再从 `recipe-media/food/` 或 `ready.js` 加载。客户端按字节数和 MD5 校验后缓存，逐张展示；公开接口不会等待图片批量下载，失败或超时后可在下次进入前台重试。图片就绪只更新有效账号页面的展示，保留筛选、随机结果和编辑草稿。静态图片的缓存路径与 URL 不写入私人 `photo`、快照或备份，也不上传到用户照片目录；保存他人菜谱时仅保留 `imageKey` 元数据。作者自传照片继续遵循本函数原有的签名与复制流程。

**2026-10-30 云端配图只读验收**：开发者工具中，21 张默认图缓存的字节数、MD5 和解码均通过；再次准备图片无需调用目录或下载，业务数据指纹不变，见 [验收报告](../../../output/cloud-recipe-covers/catalog-qa.json)。此结果不代表公开、关注、照片复制等双账号真机流程已验收。

分页固定 20 条，无后续时 `nextOffset:null`。主页食谱和关注列表保留原有 0–1000 整数 offset；粉丝列表单独允许 0–`Number.MAX_SAFE_INTEGER - 20` 的安全整数，不截断 1020 条之后的粉丝。粉丝列表每次只读取当前账号匹配的至多 21 条关系，按内部 `_id` 稳定排序但不把该字段返回客户端；分页按原始关系记录位置推进，跳过旧无主页账号后即使页面为空也应继续使用 `nextOffset`。offset 分页期间新增或取消关注可能使位置发生移动，刷新后重新从 0 加载。

关注动态使用稳定排序游标 `nextCursor`，每 20 个关注主页一次查询，每批最多读取 21 条，最多关注 200 人，单次动态查询读取量有上限。刷新首页时不传游标；继续加载使用服务器原样返回的游标。新公开发生在分页期间不会在后续游标中重复出现，重新刷新即可看到。撤回和并发变化可能使当前页不足 20 条，仍应按返回的 `nextCursor` 继续。

`discover` 返回全部用户主动公开的菜谱，按既有 `sortKey` 展示最新发布/更新；没有“热门”排行或虚构推荐。搜索最多 60 个字符、6 个空格分隔关键词，按 NFKC/小写规范化后对菜名、食材名称和当前公开作者名作字面量包含匹配，多个词均需命中上述字段之一；不搜索私密心得、宝宝资料、用餐记录或公开简介。不读取私人快照，也不为了搜索而公开任何内容。

最新列表每次读取至多 21 条公开索引候选，搜索每次读取至多 61 条、检查前 60 条；初次查询投影不包含大段做法或照片指针，仅命中候选再读取完整公开食谱，最多返回 20 条且沿用响应体上限和撤回二次检查。候选限定 `published:true`，由新索引排序后在云函数内匹配，避免对全库执行无索引正则。游标格式为 `v1.<规范化search的SHA256>.<最后已消费sortKey>`，服务端校验格式及搜索一致性，切换搜索必须清空游标。扫描窗口没有匹配时可返回 `recipes:[]` 和非空 `nextCursor`，客户端应允许继续加载，只有 `nextCursor:null` 才代表已到末尾；稀疏结果可能需要多页寻找，当前没有额外搜索服务或新数据回填。

`shareCode` 仅接受现有有效公开主页和显式 `envVersion`（`develop` / `trial` / `release`），不默认为正式版。云函数固定调用 `cloud.openapi.wxacode.getUnlimited({scene:profileId,page:'pages/profile/index',envVersion,checkPath:envVersion==='release',width:430})`，不接受客户端覆盖场景、路径、尺寸或缓存文件。32 位主页 ID 正好放入 scene；扫码页必须 `decodeURIComponent(options.scene)` 并验证 32 位十六进制，再按公开主页读取。参数与 Buffer 返回方式依据 [CloudBase 官方带参分享示例](https://docs.cloudbase.net/recipes/add-share-with-params-miniprogram)。

生成结果必须是至多 512 KiB 的 PNG 或 JPEG；根据实际 Buffer 文件头确定格式，不假设微信默认返回 PNG，也不单靠 `contentType` 信任内容。图片放入服务端管理的 `social/<profileId>/codes/<envVersion>/v1-<unique>.png` 或 `.jpg`。每个主页按三个版本缓存到 `baby_bites_profiles.shareCodes` 内部元数据，公开资料白名单不包含该字段；资料编辑与缓存写入使用事务，保留并发改名、生日修改或清除及旧月龄，不改写账号私人快照。后续请求复用图片并重新签发 300 秒 HTTPS `codeURL`，不返回 cloud fileID、不放开存储权限。300 秒指下载链接有效期，不是已保存二维码的扫描有效期。并发生成可能产生少量未引用文件，沿用保留策略，不在请求中删除文件。获取海报不会自动分享或发布小程序。

失败为 `{error:{code,message}}`，message 已是可展示的中文。错误码包括 `ACCOUNT_CHANGED`、`UNAUTHENTICATED`、`INVALID_ENV`、`INVALID_REQUEST`、`INVALID_ACCOUNT`、`INVALID_SNAPSHOT`、`INVALID_PHOTO`、`INVALID_BABY_AGE`、`STORAGE_FAILED`、`SYNC_REQUIRED`、`PROFILE_REQUIRED`、`NOT_FOUND`、`CONFLICT`、`FOLLOW_LIMIT`、`SOCIAL_FAILED`。主页码另有 `SHARE_CODE_NOT_PUBLISHED`（正式版返回微信 41030，提示正式主页尚未发布）、`SHARE_CODE_UNAVAILABLE`（微信接口/权限暂不可用）、`SHARE_CODE_FAILED`（无效图片或图片存取失败）；用户可先使用原生“发送给朋友”。不会透传底层诊断中的文件路径或其他账号信息。

## 公开资料内容审核（2026-10-30）

本轮已部署成功（9 文件约 39.5 KB），状态 Active、30 秒超时、Node.js 16.13；部署前代码已保存在小程序包外。857 项全量测试及原生编译通过。通过真实 `checkProfile` 只读请求确认正常文本通过、违规昵称与简介分别拦截，未保存测试资料，前后本机业务数据与云端主页摘要一致，见[验收记录](../../../output/profile-moderation/cloud-live.json)。

`updateProfile` 在任何数据库事务和写入前，分别审核去掉首尾空白后的昵称与非空简介。使用 [微信文本内容安全识别](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html) 的 `cloud.openapi.security.msgSecCheck`，参数固定 `version:2, scene:1`，`openid` 只取 `getWXContext()`，不接收客户端身份或审核结果。昵称同时作为 `content/nickname`，简介作为 `content/signature`；生日和私人宝宝称呼不送审。`config.json` 随部署添加 `security.msgSecCheck` 权限，保留主页码权限。

只有显式成功码和综合 `result.suggest === 'pass'` 才保存，`review/risky` 均提示修改后重试，不进入人工待审队列。昵称或简介不通过分别返回 `PROFILE_NAME_REJECTED`、`PROFILE_BIO_REJECTED`；接口缺失、权限不足、配额不足、网络异常、单次超过 8 秒或结果不完整返回 `PROFILE_MODERATION_UNAVAILABLE`，不降级放行，不改变原资料。客户端保留全部草稿并在保存栏显示错误；公开资料审核成功前不会保存同次编辑的私人宝宝称呼。每次公开资料保存重新审核，未批量回扫历史资料。

`checkProfile` 供无写入预检和部署验收，与保存共用格式校验及审核，明确返回 `saved:false`，不创建主页、不进入事务，也不更新生日或分享码。正常保存不能凭预检结果跳过审核。使用独立 action 可保证旧部署遇到该请求仅报不支持，不会因忽略参数而意外保存。

## 公开、复制与撤回边界

公开必须从当前账号已提交的私人快照选择一条，服务器不接收客户端拼装的任意内容或 fileID。公开前验证整个快照及照片归属；事务提交时再次确认快照版本和公开版本没变。公开内容是独立快照，后续私人修改不会自动泄露，必须再次公开更新。

一键添加应重新请求 `recipe`，确认仍公开；存在作者自传照片时，将 `photoURL` 下载到访客自己的本机文件，再加入访客自己的菜谱并由私人同步上传。只有默认配图时保留 `dish:<id>` 键，不下载或上传静态图片，也不填充私人 `photo`。不得把原作者的私有 cloud fileID 写到访客菜谱中。复制不会复制收藏、用餐记录或私密心得。重复添加由客户端按稳定公开 ID 去重；既有副本不会被原作者后续修改或撤回自动覆盖。

撤回写入版本墓碑，公开详情/主页/动态后续请求立即隐藏；尚在准备中的旧公开请求因版本不符失败，不能把撤回内容重新发布。已签发图片链接最多再存在 300 秒，已下载副本无法远程撤回。旧公开照片暂不删除，避免并发读取断裂；今后应以保留窗口和引用检查独立回收，不要在单次撤回后立即删除文件。

参考：[微信服务端 SDK 与类型定义](https://github.com/wechat-miniprogram/wx-server-sdk)、[CloudBase 文件管理](https://docs.cloudbase.net/storage/sdk)、[查询操作符](https://docs.cloudbase.net/en/api-reference/webv2/database/command)、[数据库查询](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/database/database.md)。

**2026-10-29 生日自动月龄部署与验收**：本次新增 `baby-age.js` 与 `babyBirthDate` 合约已通过 CLI 部署，8 个文件、36.4 KB。部署后 CLI 确认 Active、30 秒超时、Node.js 16.13；CLI 不返回内存，本次未再次访问云控制台。全量 554 项测试和 16 页、192 个 JS/WXS 脚本与原生 WXML/WXSS 编译通过。真实只读 `mine` 确认本人额外获得 `babyBirthDate:null`，现有 `profile.exists:false`；界面测试仅选择并取消生日草稿，没有创建公开主页或保存测试生日，云端资料与本机业务数据摘要前后一致。公开资料不含生日、按日期更新月龄、旧客户端兼容、清除及二维码事务并发由本地测试覆盖；实际双微信账号保存后的展示仍待真机验收。见 [生日验收报告](../../../output/birthday/qa.json)。
