# 小口袋公开主页与关注

## 家庭作用域与作者（1.6.0 后端已部署）

2026-11-04：本函数先于 Sync 更新，支持餐单、完成记录及删除历史格式，并包含最新家庭记录恢复与归属修复（上传源码 `e070ad6`）。两支函数均 Active、30 秒超时，沿用原 Node.js 16.13 配置；下载回验的 14 个运行文件与本地一致，部署前源码备份保留，未新增集合、索引或权限。见[1.6.0 部署核验](../../../output/release-1.6.0/verification.json)。客户端 1.6.0 已上传开发版本，尚未由本轮提交审核或正式发布。

家庭协议由 `babyBitesSync` 管理，部署配置见 [family-database.json](../babyBitesSync/family-database.json)。两个独立部署的函数各包含相同的 `family.js`，测试校验其字节一致。2026-11-03 已建立所需家庭、成员映射、邀请及反馈集合/索引，并按 Social → Sync 顺序部署截至 `003e39e` 的修复；两者均 Active、30 秒超时，下载源码及运行配置与本地一致，见[1.5.0 核验](../../../output/release-1.5.0/verification.json)。客户端 1.5.0 已上传开发版本，未提审或正式发布。首次部署仍须先建立 deny-all 集合与配套索引，不放宽现有私人存储权限。

社交 owner 始终为个人微信身份。涉及私人快照的操作按可信成员映射解析当前 scope，从家庭 canonical 快照读取；请求入口接受的 scope 通过每次调用独立的参数传至后续读取（含保存回执），不能在请求中途改用刚加入的家庭或退出后的个人数据。公开前 token 同时绑定 scope/membershipId、revision/fileID、内容和原作者。事务内再次验证实际调用者仍为同一次加入的成员，旧 scope、移出后重加和迟到操作不能跨家庭提交。

家庭菜谱只有 `createdBy` 本人的同步可以首次自动公开，其他成员不会替作者创建主页或发布菜谱，直接代发收到 `RECIPE_AUTHOR_REQUIRED`。`familyRecipeLink({sourceRecipeId,protocolVersion:2,expectedScope})` 可供同一家人查询已公开的原作者链接，返回 `{publication:null|{id,sourceRecipeId,sourceUpdatedAt,createdBy}}`，只读取当前家庭快照里的菜谱及对应准确公开文档，不扫描别人主页；尚无链接时由添加者完成一次同步。本人公开主页、关注及跟做反馈的作者身份不会因切换家庭而变化。

公开记录新增 `publicationScope:'personal'|'family:<familyId>'`，旧无字段记录按 personal 处理。后台对账只操作当前范围，切换家庭不会自动撤下原个人菜谱，也不会把其他家人的菜谱首次发布到自己名下。当前家庭任何成员保存共享菜谱后，可触发其已公开版本的更新和删除；publicationOwner 取原有公开记录作者，而实际成员权限始终用 actingOwner 检验，公开链接、署名和排序保留，更新路径不创建作者资料。创建家庭后，当前真实调用者是 canonical 菜谱的 `createdBy` 本人时，对账可将其原 personal 公开记录关联到当前家庭，保留原作者、公开 ID、首次时间与排序。迁移同样读取权威家庭快照，并在事务内复核来源关联、成员资格与 generation；其他家人不能代迁，不从其他家庭迁入，也不在退出后自动改回 personal。

`expectedScope` 与 `protocolVersion:2` 用于社交写入的范围保护。公开前预览、个人/家庭保存回执、自动对账、跟做发布/删除、资料和关注变更均复核成员或提交事务；保存回执验证当前家庭已同步副本，仍按真实保存者与原公开菜谱去重。公开返回不增加宝宝生日、过敏、用餐记录、家庭成员列表或内部作用域字段。

**2026-11-02 请求性能优化**：`mine` 只投影公开清单必要字段并并行读取统计，`profile` 并行读取独立信息并复用作者；新增 `profileSummary`，访客仅 3 次文档读取，不查询菜谱或计数。发现列表以最多 5 路并发处理详情，保持排序、字节上限、游标和最终公开状态检查。全量 1038 项测试及原生编译通过；部署成功（9 文件、41.8 KB），Active、30 秒、Node.js 16.13，部署后 8 个 JS/JSON 运行文件与本地一致，见[核验记录](../../../output/request-performance/verification.json)。未调整数据库权限或索引；客户端未提审发布。

**2026-11-02 自动更新部署（历史验收）**：新增 `updatePublished`，已公开菜谱保存后自动更新公开白名单字段；首次公开仍显式确认，撤回不会被并发更新复活。全量 948 项测试与原生编译通过，本函数已部署成功（9 文件、40.7 KB），状态 Active、30 秒超时、Node.js 16.13。部署后下载的 8 个 JS/JSON 运行文件与本地测试版本逐字节一致。真实模拟器核验公开详情入口，未修改真实菜谱或执行跨账号保存测试；客户端未提审发布，见[核验记录](../../../output/auto-public-update/verification.json)。

**2026-11-02 免完善资料关注部署**：首次主动关注在关系事务中创建系统默认昵称主页，取消关注不创建主页，已有资料保持。全量 914 项测试及原生编译通过；本函数已部署成功（9 文件、39.9 KB），状态 Active、30 秒超时、Node.js 16.13。部署后下载的 8 个 JS/JSON 运行文件与本地测试版本逐字节一致。未操作真实账号关注关系，跨账号真机行为仍待验收，见[核验记录](../../../output/follow-without-profile/verification.json)。

函数名 `babyBitesSocial`，AppID `wxc6c61fbebebe3340`，现有环境 `cloud1-5gxmasdl05652531`。读取接口不会自动创建主页、关注别人或公开现有菜谱；用户主动关注时，可使用系统默认昵称建立最小公开主页，无需完善资料。

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
5. 用户已授权启用相关功能；部署新版函数及新增索引后，先以只读 `mine`、`followers`、空主页确认函数连通、三集合拒绝客户端直读，再用独立测试账号/测试菜谱检查公开、关注、回关、互相关注、取消关注、复制和删除。客户端 `config/cloud.js` 的 `socialEnabled` 及 `app.json` 中主页、关注、公开菜谱路由应与新版服务一起启用并重新编译验收。旧函数不支持 `followers` 或新计数字段，不能仅打开客户端开关作为上线完成。写入验收使用独立测试数据，不修改真实用户菜谱，也不发送真实微信好友消息。
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
| `profileSummary` | `profileId` | `{profile,isSelf,following,followedBy}`；不查询菜谱或统计，用于详情页作者关系 |
| `recipe` | `recipeId` | `{recipe,author}` |
| `previewPublication` | `sourceRecipeId` | `{recipe,author,previewToken,alreadyPublished}`，只读预览 |
| `publish` | `sourceRecipeId,previewToken?`（旧 token 可选） | `{recipe}`，直接分享；收藏副本返回原作者菜谱 |
| `updatePublished` | `sourceRecipeId` | `{updated:true,recipe}` 或 `{updated:false}` |
| `syncPublications` | 可传 `expectedOwner`，家庭须 `protocolVersion:2,expectedScope` | `{updated,removed,hasMore}`；首次公开计入 `updated`，失败额外附带 `error` |
| `unpublish` | `sourceRecipeId` | `{ok:true}`，兼容旧接口；新客户端不提供公开/私密切换 |
| `follow` | `profileId,following:boolean` | `{following,followedBy}` |
| `following` | `offset?` | `{profiles,nextOffset}` |
| `followers` | `offset?` | `{profiles,nextOffset}` |
| `feed` | `cursor?` | `{recipes,nextCursor}` |
| `discover` | `search?:string,cursor?:string` | `{recipes,nextCursor}` |
| `shareCode` | `profileId,envVersion` | `{profileId,envVersion,codeURL}` |

公开 `profile` / `author` 为 `{id,name,bio,babyAgeMonths,exists}`。只有本人 `mine`、`updateProfile` 与 `profile` 且 `isSelf:true` 的 `profile` 额外包含 `babyBirthDate:string|null`；访客主页、所有菜谱作者 DTO（包括本人读取自己的菜谱及分享预览）、关注及粉丝列表均不含生日。本人身份只根据云函数可信上下文判断，不能用请求中的 `isSelf`、`owner` 或 `profileId` 冒充。主页名字 1–20 字，简介最多 120 字，不接受控制字符。`mine` 在尚未建主页时返回稳定 ID、自动昵称、空简介、`babyAgeMonths:null`、`babyBirthDate:null`、`exists:false`，不会写入数据库，也不会把宝宝称呼用作公开名字。用户首次保存主页、主动关注或明确确认公开首道用户菜谱时建立公开资料；自动创建的主页仅包含系统昵称和空简介。

默认昵称由 `sha256('public-default-name:' + owner)` 派生，为“小胡萝卜 / 小南瓜 / 小番茄 / 小土豆 / 小西兰花 / 小玉米”之一加 1000–9999 的四位数字。同一账号稳定，不保证全局唯一；名称不携带原始微信身份，不替换已有自定义名字；读取不会写入 `baby_bites_profiles`，首次主动关注或明确确认公开菜谱会在对应事务中保存默认昵称。本人主页直接显示此名称，主按钮统一为“编辑资料”。关注和公开菜谱均无需先填写资料；默认昵称预览自身不代表 `exists:true`。任何账号都不会仅因菜谱自动对账而创建主页。

`babyBirthDate` 是可选的严格 `YYYY-MM-DD` 日期字符串或 `null`。服务端拒绝错误类型、格式、无效日历日期、早于 `1900-01-01` 或晚于中国 UTC+8 当天的日期，返回 `INVALID_BABY_BIRTH_DATE`；不会把错误日期滚动为下个月。省略字段时，在事务内保留已有生日；明确传 `null` 同时清除生日和旧手动月龄。填写有效生日也会清除旧手动月龄，之后每次读取按生日和服务端中国日期计算已满月数，不把计算值写回数据库。月末生日在当月没有对应日时取该月最后一天，例如 `2025-01-31` 至 `2025-02-28` 为 1 个月，`2024-02-29` 至 `2025-02-28` 为 12 个月。生日计算结果不受旧手动输入的 120 个月上限限制。

旧 `babyAgeMonths` 输入继续接受 `null` 或 0–120 的整数，错误值返回 `INVALID_BABY_AGE`。没有生日的遗留资料继续显示原手动月龄，省略该字段时保留原值，传 `null` 清除；已有生日时始终优先按生日计算，旧客户端只改昵称、简介或旧月龄不会清除生日。若同一请求同时包含生日与旧月龄，生日字段优先处理，旧月龄存为 `null`。旧主页没有这两个字段时按 `null` 返回，无需回填或迁移；0 表示“未满1个月”，`null` 不展示。

生日只保存在禁止客户端直读写的 `baby_bites_profiles` 内部资料中，仅本人接口返回；公开的是动态月龄。生日不进入私人 snapshot、菜谱发布副本、关注记录或分享码参数。`baby-age.js` 与客户端 `utils/baby-age.js` 使用同一份中国日期、日期校验与月末算法；服务端使用可注入的 `now()` 测试跨日和生日边界。修改或清除在显式保存主页后生效，读取不会创建主页或修改现有资料。

`mine.published` 仅本人可见，条目为 `{id,sourceRecipeId,sourceUpdatedAt}`；修改时间取私人菜谱的 `updatedAt || createdAt || 0`。清单和计数均排除内置菜谱及可追溯的内置来源副本。新客户端在账号同步成功后调用 `syncPublications`，只自动更新仍公开的既有菜谱及移除已删除、内置条目；未分享及已撤回的菜谱不会被创建或恢复。旧客户端的 `updatePublished` 仍只更新已有公开记录。

`following` / `followers` 仅列出真实调用账号的关注/粉丝；传入 `owner`、`profileId` 不会切换为他人列表。每项只包含 `{id,name,bio,babyAgeMonths,exists,following,followedBy}`，其中 `following` 表示“我关注对方”，`followedBy` 表示“对方关注我”；两者都为 `true` 即互相关注，只有 `followedBy` 时可通过已有 `follow` 操作回关。`profile` 的关系布尔值同样相对于当前调用者，三个计数则属于被查看的主页；`publishedCount` 为总数，不是当前 20 条列表的长度。

关注不要求完善资料。在目标主页、关注上限及双向关系校验通过后，若本人尚无主页，服务端会在同一事务中保存 `{owner,name:defaultProfileName(owner),bio:"",updatedAt}` 与关注关系；不接收客户端提供的昵称，不读取私人快照或宝宝信息，固定系统昵称无需用户文本审核。已有有效主页完整保留，存在但损坏的本人资料返回 `INVALID_ACCOUNT`，不会覆盖。重复关注不重复添加，也可补齐旧版无主页账号的默认档案；取消关注不创建主页，且不要求本人或目标主页仍存在。计数直接来自关系记录，无额外计数器漂移。用户之后主动修改昵称或简介仍经过原有文本审核。

旧版本允许未设置公开主页的账号关注别人；这些关系保留并计入关系数，不自动替旧账号生成公开资料。粉丝列表跳过尚无有效公开主页的旧账号；本人以后保存主页或再次主动关注时，该已有关系会以公开资料出现在列表中。因此历史关系可能造成计数高于当前可展示的主页数，页面应保留服务器提供的分页位置。缺失或损坏的主页不会暴露对应内部 owner 或私有资料。

公开菜谱白名单：`{id,profileId,authorName,name,category,minutes,texture,ingredients,steps,imageKey,photoURL,updatedAt,publishedAt}`，另可包含 `ageGroups`。月龄标签仅从已提交的私人快照读取，枚举为 `6-8 / 9-11 / 12-17 / 18+`；数组最多 4 项，校验后去重并按枚举排序。缺失字段保持省略，`[]` 表示明确清空；客户端将两者均解释为不限月龄，参与任意月龄的抽选，不需要补写全部标签。发布请求自行附带的标签不作为来源。保存副本时保留明确的标签，已公开菜谱保存修改后自动同步这些公开字段。如果来自其他公开食谱，可带 `source:{profileId,recipeId,authorName}`。来源作者名由服务器真实记录解析，不能靠客户端伪造；原作者删除菜谱后，已有用户副本和已保存的来源仍然保留；内置来源副本除外。不会返回私人 note、favorite、宝宝称呼、用餐记录、内部 owner、来源私有菜谱 ID、云文件 ID 或内部照片 hash。

`recipe-covers.js` 保留 21 个准确内置菜谱 ID 的配图映射，并导出稳定 ID 判定。内置菜谱及历史内置来源副本不进入任何社交菜谱接口；即使旧编辑器清除 `isExample`，固定 ID 仍会拦截。普通用户菜谱可以使用明确的 `dish:<id>` 配图键，配图键本身不作为内置判定依据；作者照片仍通过独立 `photoURL` 返回。

配图包含原有 3 张及内置 `image_gen` 逐菜生成的 18 张，成品图与完整提示词来源见客户端 [资源说明](../../assets/food/ASSETS.md)。21 张 JPEG 现由独立的 [babyBitesAssets](../babyBitesAssets/README.md) 云函数按固定清单签发临时 URL；原文件归档在小程序包外的 [工作区目录](../../../output/cloud-recipe-covers/source/)，不再从 `recipe-media/food/` 或 `ready.js` 加载。客户端按字节数和 MD5 校验后缓存，逐张展示；公开接口不会等待图片批量下载，失败或超时后可在下次进入前台重试。图片就绪只更新有效账号页面的展示，保留筛选、随机结果和编辑草稿。静态图片的缓存路径与 URL 不写入私人 `photo`、快照或备份，也不上传到用户照片目录；保存他人菜谱时仅保留 `imageKey` 元数据。作者自传照片继续遵循本函数原有的签名与复制流程。

**2026-10-30 云端配图只读验收**：开发者工具中，21 张默认图缓存的字节数、MD5 和解码均通过；再次准备图片无需调用目录或下载，业务数据指纹不变，见 [验收报告](../../../output/cloud-recipe-covers/catalog-qa.json)。此结果不代表公开、关注、照片复制等双账号真机流程已验收。

分页固定 20 条，无后续时 `nextOffset:null`。主页食谱和关注列表保留原有 0–1000 整数 offset；粉丝列表单独允许 0–`Number.MAX_SAFE_INTEGER - 20` 的安全整数，不截断 1020 条之后的粉丝。粉丝列表每次只读取当前账号匹配的至多 21 条关系，按内部 `_id` 稳定排序但不把该字段返回客户端；分页按原始关系记录位置推进，跳过旧无主页账号后即使页面为空也应继续使用 `nextOffset`。offset 分页期间新增或取消关注可能使位置发生移动，刷新后重新从 0 加载。

关注动态使用稳定排序游标 `nextCursor`，每 20 个关注主页一次查询，每批最多读取 21 条，最多关注 200 人，单次动态查询读取量有上限。刷新首页时不传游标；继续加载使用服务器原样返回的游标。新公开发生在分页期间不会在后续游标中重复出现，重新刷新即可看到。删除、内置过滤和并发变化可能使当前页不足 20 条，仍应按返回的 `nextCursor` 继续。

`discover` 返回用户明确公开的菜谱，按既有 `sortKey` 展示；没有“热门”排行或虚构推荐。搜索最多 60 个字符、6 个空格分隔关键词，按 NFKC/小写规范化后对菜名、食材名称和当前公开作者名作字面量包含匹配，多个词均需命中上述字段之一；不搜索私密心得、宝宝资料、用餐记录或公开简介。不读取私人快照，也不为了搜索而公开任何内容。

最新列表每次读取至多 21 条公开索引候选，搜索每次读取至多 61 条、检查前 60 条；初次查询投影不包含大段做法或照片指针，仅命中候选再读取完整公开食谱，最多返回 20 条且沿用响应体上限和可见性二次检查。候选限定 `published:true`，由新索引排序后在云函数内匹配，避免对全库执行无索引正则。游标格式为 `v1.<规范化search的SHA256>.<最后已消费sortKey>`，服务端校验格式及搜索一致性，切换搜索必须清空游标。扫描窗口没有匹配时可返回 `recipes:[]` 和非空 `nextCursor`，客户端应允许继续加载，只有 `nextCursor:null` 才代表已到末尾；稀疏结果可能需要多页寻找，当前没有额外搜索服务或新数据回填。

`shareCode` 仅接受现有有效公开主页和显式 `envVersion`（`develop` / `trial` / `release`），不默认为正式版。云函数固定调用 `cloud.openapi.wxacode.getUnlimited({scene:profileId,page:'pages/profile/index',envVersion,checkPath:envVersion==='release',width:430})`，不接受客户端覆盖场景、路径、尺寸或缓存文件。32 位主页 ID 正好放入 scene；扫码页必须 `decodeURIComponent(options.scene)` 并验证 32 位十六进制，再按公开主页读取。参数与 Buffer 返回方式依据 [CloudBase 官方带参分享示例](https://docs.cloudbase.net/recipes/add-share-with-params-miniprogram)。

生成结果必须是至多 512 KiB 的 PNG 或 JPEG；根据实际 Buffer 文件头确定格式，不假设微信默认返回 PNG，也不单靠 `contentType` 信任内容。图片放入服务端管理的 `social/<profileId>/codes/<envVersion>/v1-<unique>.png` 或 `.jpg`。每个主页按三个版本缓存到 `baby_bites_profiles.shareCodes` 内部元数据，公开资料白名单不包含该字段；资料编辑与缓存写入使用事务，保留并发改名、生日修改或清除及旧月龄，不改写账号私人快照。后续请求复用图片并重新签发 300 秒 HTTPS `codeURL`，不返回 cloud fileID、不放开存储权限。300 秒指下载链接有效期，不是已保存二维码的扫描有效期。并发生成可能产生少量未引用文件，沿用保留策略，不在请求中删除文件。获取海报不会自动分享或发布小程序。

失败为 `{error:{code,message}}`，message 已是可展示的中文。错误码包括 `ACCOUNT_CHANGED`、`UNAUTHENTICATED`、`INVALID_ENV`、`INVALID_REQUEST`、`INVALID_ACCOUNT`、`INVALID_SNAPSHOT`、`INVALID_PHOTO`、`INVALID_BABY_AGE`、`STORAGE_FAILED`、`SYNC_REQUIRED`、`PROFILE_REQUIRED`、`PREVIEW_REQUIRED`、`PREVIEW_STALE`、`NOT_FOUND`、`CONFLICT`、`FOLLOW_LIMIT`、`SOCIAL_FAILED`。主页码另有 `SHARE_CODE_NOT_PUBLISHED`（正式版返回微信 41030，提示正式主页尚未发布）、`SHARE_CODE_UNAVAILABLE`（微信接口/权限暂不可用）、`SHARE_CODE_FAILED`（无效图片或图片存取失败）；用户可先使用原生“发送给朋友”。不会透传底层诊断中的文件路径或其他账号信息。

## 公开资料内容审核（2026-10-30）

本轮已部署成功（9 文件约 39.5 KB），状态 Active、30 秒超时、Node.js 16.13；部署前代码已保存在小程序包外。857 项全量测试及原生编译通过。通过真实 `checkProfile` 只读请求确认正常文本通过、违规昵称与简介分别拦截，未保存测试资料，前后本机业务数据与云端主页摘要一致，见[验收记录](../../../output/profile-moderation/cloud-live.json)。

`updateProfile` 在任何数据库事务和写入前，分别审核去掉首尾空白后的昵称与非空简介。使用 [微信文本内容安全识别](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html) 的 `cloud.openapi.security.msgSecCheck`，参数固定 `version:2, scene:1`，`openid` 只取 `getWXContext()`，不接收客户端身份或审核结果。昵称同时作为 `content/nickname`，简介作为 `content/signature`；生日和私人宝宝称呼不送审。`config.json` 随部署添加 `security.msgSecCheck` 权限，保留主页码权限。

只有显式成功码和综合 `result.suggest === 'pass'` 才保存，`review/risky` 均提示修改后重试，不进入人工待审队列。昵称或简介不通过分别返回 `PROFILE_NAME_REJECTED`、`PROFILE_BIO_REJECTED`；接口缺失、权限不足、配额不足、网络异常、单次超过 8 秒或结果不完整返回 `PROFILE_MODERATION_UNAVAILABLE`，不降级放行，不改变原资料。客户端保留全部草稿并在保存栏显示错误；公开资料审核成功前不会保存同次编辑的私人宝宝称呼。每次公开资料保存重新审核，未批量回扫历史资料。

`checkProfile` 供无写入预检和部署验收，与保存共用格式校验及审核，明确返回 `saved:false`，不创建主页、不进入事务，也不更新生日或分享码。正常保存不能凭预检结果跳过审核。使用独立 action 可保证旧部署遇到该请求仅报不支持，不会因忽略参数而意外保存。

## 自动公开、直接分享与内置隔离（2026-11-03，尚未部署）

私人快照允许可选 `allergies` 与 `allergiesUpdatedAt` 并严格校验，保持与私人同步协议兼容；这些信息不进入主页、菜谱、分享、发现或关注接口的公开白名单。推荐筛选由调用者的客户端使用自己的私人记录完成，不向社交接口上传过敏食物。

最新规则取代 2026-11-02 的预览确认流程：自己的新建和导入菜谱在同步成功后自动公开，分享直接使用公开链接。服务端只使用权威快照的菜名、食材、做法、适龄和照片等白名单；私人心得、宝宝资料、过敏和用餐记录不公开。带 `source` 的收藏副本不重复发布，对账撤下旧重复副本；直接 `publish` 收藏副本兼容返回仍有效的原作者菜谱链接，原菜谱失效则返回 `NOT_FOUND`。

旧 `previewPublication` API 保留兼容且仍为只读，当前客户端无需调用。其 `previewToken` 仍绑定账号、scope/membershipId、快照 revision/fileID、菜谱白名单、照片路径、作者公开资料和发布 generation。若旧客户端主动传入 token，服务端继续校验，过期返回 `PREVIEW_STALE`；未传入 token 不影响直接分享。

直接调用 `publish({sourceRecipeId})` 不要求预览 token，不接受客户端拼装内容。照片复制后，事务再次核对快照、成员身份及公开记录 generation，并原子创建公开记录与安全默认主页；已有自定义资料保持。新版直调与旧 token 调用均不能越过当前账号和家庭作者校验。

`syncPublications` 按可信身份与 `expectedOwner/expectedScope` 读取已提交快照，不接受客户端拼装内容、owner 或 fileID。每批优先移除已删除、墓碑覆盖、内置和收藏副本，再首次公开或更新自有菜谱，最多处理 8 条；首次公开也计入 `updated`。返回 `{updated,removed,hasMore}`，未完成或中途失败可重试。所有变更在事务内复核 snapshot revision/fileID、scope/membershipId 和 generation；家庭其他成员仍只有已公开版本的更新权限。

策略升级为 `publicationPolicyVersion:3`，使同 revision 的旧策略账号重新对账。仍在权威快照中的自有菜谱，包括旧未分享或旧 withdrawn 记录，会在原作者同步时公开；已删条目、内置、收藏副本和其他 scope 不恢复。新公开记录与后续删除墓碑携带策略 3 标记，迁移不能复活并发的新撤回。只有整批完成且快照未变才在个人账号索引写入策略与 `publicationRevision`，随后同版本跳过下载与扫描；家庭不复用个人标记。标记不改变业务 revision、宝宝资料或快照文件。

内置身份同时检查固定 21 个 ID、`isExample` 和历史来源记录；保存副本的 `shared-<publicId>` 与来源链都不能绕过。来源文档在单次请求内去重读取，递归逐路径检查循环。当前快照已知的内置身份在对账前登记，撤除墓碑保留 `builtin:true` 和来源，防止原记录退下后其他账号副本重新出现。发现、关注、访客主页、详情旧链接和对应计数统一排除这些记录；本机内置菜谱及个人选餐不受影响。

公共清单每次最多读取两窗、每窗 1000 条投影；超出范围的历史索引由批量对账逐步清理，未完成时不会标记为已对账。公共读取遇到过量历史记录明确提示作者同步整理，不返回被截断的总数。过滤后的空页仍推进原始游标。

`publish` 同更新时间的重复分享不写记录、不重新复制照片，也不改变排序。`updatePublished` 保留仅更新已有公开记录的旧合约；新客户端通过 `syncPublications` 完成首次公开。`unpublish` 保留旧接口与墓碑语义，客户端不再提供公开/私密切换入口。删除菜谱先提交删除墓碑，再通过批量对账移除公共记录；旧 token 与迟到请求不能穿透版本校验。

自动更新保留稳定公开 ID、`publishedAt` 与 `sortKey`，不因普通保存反复置顶。服务端内部 `sourcePhotoHash` 用于复用未变化的公开照片；替换或清除照片时同步相应变化，旧记录首次自动更新会补齐该字段。私人心得、收藏、宝宝资料和用餐记录均不进入公开记录。暂时失败时私人提交仍有效，客户端保留待同步状态，并在后续修改、联网恢复、回到前台或手动同步时重试。

撤回记录的 `withdrawalReason` 区分删除（`deleted`）、手动撤回（`manual`）和不再符合公开条件（`ineligible`）。从备份恢复已删除的自有菜谱后，原作者同步即可恢复原分享链接。策略 3 中没有记录原因的历史撤回保持隐藏。

一键添加应重新请求 `recipe`，确认仍公开；存在作者自传照片时，将 `photoURL` 下载到访客自己的本机文件，再加入访客自己的菜谱并由私人同步上传。只有默认配图时保留 `dish:<id>` 键，不下载或上传静态图片，也不填充私人 `photo`。不得把原作者的私有 cloud fileID 写到访客菜谱中。复制不会复制收藏、用餐记录或私密心得。重复添加由客户端按稳定公开 ID 去重；既有用户副本不会被原作者后续修改或删除自动覆盖，内置来源会持续被识别并隔离。

删除对账写入版本墓碑，公开详情/主页/动态后续请求隐藏；尚在准备中的旧同步请求因快照或版本不符失败，不能恢复已删内容。已签发图片链接最多再存在 300 秒，已下载副本无法远程撤回。旧公开照片暂不删除，避免并发读取断裂；今后应以保留窗口和引用检查独立回收，不要在单次删除后立即回收历史文件。仅本次刚复制、且事务明确因 revision/generation 冲突等原因未提交的新照片可做尽力清理；网络结果不明确时保留，避免删除可能已生效的照片。

参考：[微信服务端 SDK 与类型定义](https://github.com/wechat-miniprogram/wx-server-sdk)、[CloudBase 文件管理](https://docs.cloudbase.net/storage/sdk)、[查询操作符](https://docs.cloudbase.net/en/api-reference/webv2/database/command)、[数据库查询](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/database/database.md)。

**2026-10-29 生日自动月龄部署与验收**：本次新增 `baby-age.js` 与 `babyBirthDate` 合约已通过 CLI 部署，8 个文件、36.4 KB。部署后 CLI 确认 Active、30 秒超时、Node.js 16.13；CLI 不返回内存，本次未再次访问云控制台。全量 554 项测试和 16 页、192 个 JS/WXS 脚本与原生 WXML/WXSS 编译通过。真实只读 `mine` 确认本人额外获得 `babyBirthDate:null`，现有 `profile.exists:false`；界面测试仅选择并取消生日草稿，没有创建公开主页或保存测试生日，云端资料与本机业务数据摘要前后一致。公开资料不含生日、按日期更新月龄、旧客户端兼容、清除及二维码事务并发由本地测试覆盖；实际双微信账号保存后的展示仍待真机验收。见 [生日验收报告](../../../output/birthday/qa.json)。

## 菜谱被保存与跟做反馈（2026-11-02，待部署）

新增云端集合 `baby_bites_recipe_feedback`。部署前先依据 [feedback-database.json](./feedback-database.json) 创建集合、三个复合索引，并将集合权限设为所有客户端 `read:false, write:false`；这是可审阅的配置清单，不会仅因上传云函数而自动应用。所有读写由 `babyBitesSocial` 云函数按可信微信身份完成。新增 `config.json` 权限 `security.imgSecCheck`，保留 `security.msgSecCheck` 及主页码权限。当前代码仅本地验证，尚未部署、初始化线上集合或写入真实用户反馈。

| Action | 输入 | 输出 |
| --- | --- | --- |
| `recordSave` | `recipeId,localRecipeId` | `{recorded:boolean}` |
| `recipeFeedback` | `recipeId,offset?` | `{saveCount,cooksnapCount,cooksnaps,nextOffset}` |
| `feedbackInbox` | `offset?` | `{saveCount,cooksnapCount,items,nextOffset}` |
| `addCooksnap` | `recipeId,requestId,photoFileID,text` | `{cooksnap}` |
| `deleteCooksnap` | `id` | `{deleted:true}` |

所有操作支持既有 `expectedOwner` 账号保护。`recordSave` 必须找到当前调用者权威已提交快照中的有效副本，其 `source.recipeId`、`source.profileId` 要匹配当前仍分享的菜谱及作者，并在事务内复核快照未变化。每位保存者与每道菜谱采用唯一事件 ID，重试、重复保存与删后重存不会增加人数；阅读、点击、自己保存自己的菜谱均不计数。事件表示真实发生过的保存，之后从自己的食谱删除副本不撤销这段历史。保存反馈对作者只展示匿名事件，不暴露保存者姓名、账号、宝宝资料或私人副本信息。该操作之外的反馈读写不下载私人快照。

跟做只接受一张成品照与 1–120 字反馈，`requestId` 为 8–100 位字母、数字、下划线或短横线。照片必须来自当前云环境中当前调用者的 `users/<owner>/photos/`，限 JPG/PNG、1 MB、750×1334 像素以内；客户端压缩长边到 750 像素。服务端读取原始字节检查格式、尺寸与大小，再调用 `msgSecCheck({version:2,scene:2,openid,content})` 和 `imgSecCheck({media:{contentType,value:Buffer}})`。文字必须明确成功且 `result.suggest=pass`，图片必须明确成功码；违规、待复核、缺失结果、接口缺失或任一审核超过 8 秒均不公开，不降级放行。

审核通过后才复制至 `social/<profileId>/cooksnaps/<id>/<unique>.jpg|png`，事务重新验证原菜谱仍有效且版本未变。跟做 ID 绑定当前账号和 `requestId`，幂等摘要绑定菜谱、文字及图片字节；同一请求重传同一照片仍返回原记录，改内容重用请求 ID 返回 `CONFLICT`。公开 DTO 严格仅含 `{id,recipeId,author:{id,name},photoURL,text,createdAt,isSelf}`。无公开资料时采用稳定系统昵称，无需先完善资料，也不创建公开主页或访问私人宝宝资料。

`deleteCooksnap` 只允许跟做者本人操作；成功后保留不可复活的墓碑，计数与列表立即排除，旧请求不能恢复它。事务提交后尽力删除这条跟做独立的公开照片，绝不删除私人原图；重复删除可重试清理。已签发 URL 的 300 秒寿命及用户已下载图片不保证立即消失。仅能证明未被提交引用的新副本才在失败时清理；事务结果不明确则保留，以免误删已发布照片。

`recipeFeedback` 只读取仍分享且非内置的菜谱，返回完整真实保存人数/跟做次数及每页最多 20 条跟做。`feedbackInbox` 仅当前作者可见，忽略请求中的其他身份字段；仅统计仍分享的非内置菜谱。总数由数据库 count 获取，按至多 20 个菜谱 ID 分组，既不按当前页长度冒充总数，也不扫描全部反馈。列表沿用现有 offset 约定，范围 0–1000，每次读取最多 21 行、返回最多 20 行；超出范围明确拒绝。总数不受列表窗口限制。原菜谱移除或变为内置后，后续读取不返回对应反馈；删除或撤回发生在签发照片 URL 期间也会再次检查，避免返回已撤内容。

集合中的 `owner`（反馈者）、`authorOwner`（菜谱作者）、幂等摘要和照片 fileID 均仅服务端内部使用；公开返回使用签名 HTTPS URL。作者收件箱的保存事件只含 `{id,type,recipeId,recipeName,createdAt,photoURL:'',text:''}`；跟做事件额外提供公开 `actorName`、照片 URL 和一句反馈。无评论回复、点赞或订阅消息发送。

图片审核 API 参考：[微信图片安全检查](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_imgseccheck.html)、[官方云函数 SDK](https://github.com/wechat-miniprogram/wx-server-sdk)。部署后仍需通过真实微信云调用验收新增图片审核权限和数据库索引；本地模拟测试不代表线上服务已可用。
