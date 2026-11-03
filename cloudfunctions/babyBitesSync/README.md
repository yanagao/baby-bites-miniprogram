# 小口袋账号同步云函数

## 家庭共享协议（2026-11-03 源码）

微信身份与家庭数据分开：`owner` 始终是可信微信上下文计算的个人账号标识，不会替换成家庭 ID。每个账号最多加入一个家庭，每个家庭当前管理一个宝宝，最多 20 位成员。加入后共享宝宝称呼、生日、过敏记录、菜谱、收藏和用餐记录；个人主页、关注和作者身份继续属于个人。是否在推荐时跳过过敏食材是本机个人偏好，默认关闭，按账号、scope 和 membershipId 隔离，不属于共享快照。

上线须按 [family-database.json](./family-database.json) 创建三个 deny-all 集合及公开菜谱的家庭清单索引，并按 [反馈配置](../babyBitesSocial/feedback-database.json) 创建配套集合/索引，再部署 `babyBitesSync` 与 `babyBitesSocial`、上传新版客户端。新身份读取会查询成员映射，不能漏建集合后直接部署；配置清单不会自行应用。真实部署证据与多账号真机验收另记，不以本地源码或单元测试通过宣称已上线。

2026-11-03 部署记录：已在既有环境创建上述 4 个 deny-all 集合与 4 个复合索引，并部署 Sync/Social；两支函数均 Active、30 秒超时，线上源码与本地全部 JS 的 SHA-256 一致。保持原存储规则及其他业务函数不变。证据见[部署核验](../../../output/family-sharing/device-2026-11-03/deployed/verification.json)。此记录不代表客户端正式发布或多账号真机验收。

- `identity({protocolVersion:2})` 返回 `{owner,scope,revision,fileID}`，scope 为 `{kind:'personal',id:owner}` 或 `{kind:'family',id,membershipId}`。家庭成员使用旧客户端读取或提交均返回 `CLIENT_UPDATE_REQUIRED`。
- `familyState` 返回 `{owner,scope,family}`；family 包含 `id/name/isManager/memberId/membershipId/memberCount/members`，成员仅含 `{id,label,isManager,isSelf}`，不暴露成员微信 owner。
- `familyCreate({name,roleLabel,requestId,baseRevision})` 以本人当前已提交个人快照初始化家庭。无个人云端索引且 `baseRevision:0` 时建立空家庭，不接受客户端夹带快照；个人索引保持原样。请求 ID 幂等。私有快照已有生日（含显式 null）优先，无字段时仅复制本人合法公开主页生日到新私有快照，不修改公开主页，也不迁移其他公开资料。
- `familyInvite` 仅管理员可用，返回 128 位随机 base64url token 和 24 小时过期时间；生成新邀请使旧邀请失效，每份邀请只可加入一人。`familyPreview({token})` 只展示家庭名、宝宝称呼、人数和有效期，不含健康记录。`familyJoin({token,roleLabel,requestId})` 明确确认后加入，事务消费邀请并建立成员身份，不合并原个人数据。
- `familyRole({roleLabel})` 只改自己称谓。管理员可 `familyRemove({memberId})` 移除其他人、`familyTransfer({memberId})` 转让管理员。`familyLeave` 退出；管理员有其他成员时必须先转让，最后一人退出时关闭家庭。原个人数据保留，家庭数据不会自动拷回个人空间；关闭的家庭和历史文件仍按保留策略保存，不宣称永久删除。
- 管理操作使用 `protocolVersion:2,expectedOwner,expectedScope`；事务再次验证当前成员。重新加入产生新 membershipId，旧页面、旧邀请和旧缓存不能借相同家庭 ID 恢复权限。创建或加入丢响应后可用相同 requestId 恢复已成功结果。
- `familyRead({expectedScope})` 返回 `{owner,scope,revision,fileID,snapshot,photoURLs}`。为满足[微信小程序云函数响应 1 MiB 上限](https://docs.cloudbase.net/error-code/EXCEED_MAX_RESPONSE_SIZE)，JSON 快照超过 512 KiB 时省略 `snapshot`，改为返回当前 canonical 文件的 HTTPS `snapshotURL`，客户端下载后校验不超过 5 MiB 并解析。快照下载链接单独签名，不占首批最多 20 张当前引用照片的名额；`familyPhotos({fileIDs:[...]})` 每次最多 20 张，返回 `{owner,scope,photoURLs}`，只允许当前快照精确引用的照片。签发后重新验证成员及 revision/fileID，移出、换家或数据变化不返回旧内容。快照与照片签名均有效 300 秒，已签发 URL 与已经看到的内容无法倒追撤回。
- 家庭 `commit({protocolVersion:2,expectedScope,baseRevision,fileID})` 接受当前调用者上传的 `users/<owner>/snapshots/` 暂存文件。新照片仅允许本人 `users/<owner>/photos/` 或上一家庭快照精确引用的 canonical 照片，不泛允许家人其他私人照片路径。服务端复制新图片和快照到 `families/<familyId>/photos|snapshots/`，不放宽现有仅创建者读写规则；成员删除自己的私人照片不会破坏家庭照片。
- 提交继续使用 revision 乐观锁。成功返回 canonical `snapshot`（超过 512 KiB 改为 `snapshotURL`）与首批 `photoURLs`，客户端必须应用该快照以获得规范文件 ID 和服务端记录人标记；冲突返回当前 revision/fileID/scope，再读取、合并并重试。事务比较 scope、membershipId 和 revision；签名回包再次核验提交的 revision/fileID，避免返回已被更新的版本。无法确定提交是否成功时不删除文件，仅清理确定未提交的新拷贝。

私有快照新增可选 `babyBirthDate`（有效日期或 null）及 `babyBirthDateUpdatedAt`。保存后拒绝旧客户端丢弃或回退生日字段，过敏保护保持。家庭菜谱新增 `createdBy`：创建家庭时原数据归创建者，新菜谱由服务器标记当前成员；已存在作者不可改。新用餐记录追加 `recordedBy:{memberId,label}`，旧记录不伪造记录人，已有归属不随称谓变化或编辑改写。这些归属与宝宝资料不出现在公开菜谱 DTO。

快照提交后，配套 `babyBitesSocial.syncPublications` 自动公开用户自有非内置菜谱，分享不需要预览，也没有公开/私密选择。策略 v3 会处理仍在权威快照中的历史自有菜谱，包括旧策略未分享记录；已删除菜谱不恢复，内置及其来源副本不进入推荐，保存他人的菜谱沿用原作者链接、不重复发布。首次公开家庭菜谱仅由 `createdBy` 本人的同步触发；其他现成员可以更新和删除当前家庭已公开版本，保留原作者与链接。当前添加者自己的同步可把其原 personal 菜谱关联到当前家庭，保留作者、公开 ID 与排序；其他成员不能代迁，不允许其他家庭自动迁入或退出后自动回个人。家庭切换不会把其他 scope 的菜谱判为已删除，写入仍验证成员、revision 和 generation。宝宝生日、过敏、心得和用餐记录不进入公开菜谱。详见[社交函数文档](../babyBitesSocial/README.md)。

家庭快照的删除记录由服务端保留原菜谱作者、来源和用餐记录人。从备份恢复时以服务端历史为准，无法核实的归属留空。最后一位成员退出前，服务端会检查已删除的菜谱是否仍然公开。如果返回 `PUBLICATION_PENDING`，家庭仍有效，下一次退出会先重试同步。升级时先部署能读取新删除记录的 `babyBitesSocial`，再部署写入这些记录的 `babyBitesSync`。

旧家庭第一次由成员访问时会校验快照中的菜谱署名。初始快照由建家人提供。已有多人编辑的旧快照里，只有存在建家前独立公开记录并已关联本家庭的菜谱才保留其他成员的署名。缺少证据时保留菜谱内容，署名留空，原始快照文件保留供核对。

“我的”已移除“收到的反馈”入口。家庭菜谱仍支持保存回执和跟做，只有实际保存副本的成员能产生对应的回执。推荐筛选开关按账号、家庭和成员资格保存在本机，默认关闭。家人共享过敏记录，各自选择是否筛选。

正式 AppID：`wxc6c61fbebebe3340`；现有环境：`cloud1-5gxmasdl05652531`；函数名：`babyBitesSync`。本目录不自行开通云开发或创建付费环境。测试号不支持账号同步。

历史验收（2026-10-23，个人同步版本）：账号集合为所有客户端不可读写，存储原规则为仅创建者读写且未改动。正式微信账号完成真实上传及再次下载，独立空缓存通过真实云接口恢复了 9 道菜谱、4 条记录和 1 张照片。客户端直接读取账号集合返回权限拒绝；当时未完成双账号真机交叉验收。这不代表本次家庭与自动公开版本已上线。该环境另有其他用途的云函数，后续须保留其既有存储访问方式。

## 部署

1. 在微信开发者工具打开 AppID 为 `wxc6c61fbebebe3340` 的项目，选中既有环境 `cloud1-5gxmasdl05652531`。复核 `config/cloud.js` 指向该环境，不另建环境，也不因增量部署重置既有配置；从零配置时应先完成集合与权限，再启用客户端同步。
2. 确认既有 `baby_bites_accounts` 集合及客户端不可直接读写规则；补齐上方家庭和反馈清单中的集合与索引。已有集合和用户数据不得重建覆盖，只允许相应服务端函数按权限访问。
3. 确保 `users/<owner>/snapshots/` 和 `users/<owner>/photos/` 仅允许文件创建者本人读写。`cloud/storage.rules.json` 是**独占环境模板**；本环境存在其他业务，需先读取原规则与实际使用路径，合并权限后应用，不能直接全局改为私有。经典安全规则支持 `/^public\\//.test(resource.path)` 等路径白名单，以及 `resource.openid == auth.openid` 所有者检查；不支持对 `.test()` 结果使用 `!` 取反，因此不能猜写“所有非 users/ 都公开”。应明确保留既有公开目录和原有写入条件，再验证小口袋目录私有；如果无法确认原有目录用途，应先停留在配置阶段。规则发布可能需要几分钟生效；验收须确认本人可上传和下载、另一微信账号不可下载，并确认旧业务仍可访问原文件。
4. `project.config.json` 指定 `"cloudfunctionRoot": "cloudfunctions/"`。右键 `babyBitesSync`，选择“上传并部署：云端安装依赖”，或使用已开启服务端口的官方 CLI：

   ```sh
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud env list --project PROJECT
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy --env cloud1-5gxmasdl05652531 --names babyBitesSync --remote-npm-install --project PROJECT
   ```

   将 `PROJECT` 替换为绝对项目路径（有空格时加引号）。不要部署到其他项目或环境。SDK 固定为 npm 官方稳定版 `wx-server-sdk@4.0.2`，依赖由锁文件固定。云函数使用 Node.js 18 或更高版本，适当配置超时以完成最大 5 MiB 快照下载。
5. 配套部署 `babyBitesSocial` 后，验证身份与家庭权限、原有数据迁移、第二台设备恢复、离线及并发修改、自动公开和删除、成员移出后的访问拒绝。同步范围包括宝宝称呼、生日、过敏记录、菜谱、收藏、用餐记录和照片；本机推荐过滤开关不共享。微信昵称及头像不属于身份识别必需信息。部署与真机证据另行记录。

## 账号与迁移行为

同一微信账号在同一 AppID 和环境中保留个人数据；未加入家庭的不同账号彼此隔离，确认加入同一家庭后改用该家庭的共享数据，原个人记录保留、不自动合并。首次成功识别账号时，客户端将未绑定的旧 `baby-bites-v1` 内容合并到该账号并写入一次性归属标记，切换账号不会再次上传给别人。其他 AppID 或网页版的数据需由用户导出、导入备份迁移。

修改先落地本机，再在前台、联网恢复及编辑后同步；「设置 → 微信账号同步」可手动重试。离线时保留本机修改，首次在新设备恢复需要网络。多设备以条目 ID 和修改时间合并，删除历史避免旧缓存恢复已删内容；同一条目的冲突按较新修改处理，不逐字段拼接。客户端提交时使用云端 revision；不匹配则读取新版本重新合并，不直接覆盖。

## 协议与权限

过敏记录为私人快照的可选 `data.allergies`（最多 50 个去重食物名称，每项 1–40 字）与 `data.allergiesUpdatedAt`（非负安全整数）。旧快照可缺省两字段，明确空数组用于清空。账号索引仅额外记录最后的 `allergiesUpdatedAt`，不复制食物内容；一旦记录过该字段，缺字段提交返回 `CLIENT_UPDATE_REQUIRED`，时间更旧的提交返回当前索引的 `conflict:true`，防止旧客户端静默清除设置。本人身份/索引响应仍只包含原有字段，不公开过敏内容或标记。

上述过敏字段在家庭内共享；默认关闭的“跳过过敏食材”开关没有云端协议字段，修改开关不改变 snapshot revision，也不上传或合并该偏好。

当前客户端以 `wx.cloud.callFunction({name:'babyBitesSync', data:{action:'identity',protocolVersion:2}})` 查询当前账号及 scope。用户标识为 `sha256(APPID + ':' + OPENID)`，只从 `cloud.getWXContext()` 计算，客户端传入 owner/openid 不参与授权。下列旧字段为个人模式的兼容协议；当前请求额外携带 scope，家庭协议见上方。

- `identity` 返回 `{owner, revision, fileID}`；新账号为版本 `0`、空 `fileID`，查询不会写数据库。
- `commit` 参数为 `{action:'commit', baseRevision, fileID}`。先下载并校验快照，再在数据库事务内比较版本号。成功返回更新后的指针；冲突返回 `{conflict:true, owner, revision, fileID}`，不会覆盖其他设备的新版本。
- 失败返回 `{error:{code,message}}`，不暴露底层存储路径或第三方账号标识。
- 照片路径为 `users/<owner>/photos/<unique>.jpg|png|webp`；快照为 `users/<owner>/snapshots/<unique>.json`。每次上传必须使用新文件名，后续不要覆盖已经发布的快照。客户端负责上传、下载，服务端只读取属于当前环境、当前账号目录下的快照。
- 快照结构为 `{version:1,data:{version:1,nickname,profileUpdatedAt,recipes,logs},deleted:{recipes:[{id,updatedAt}],logs:[{id,updatedAt}]}}`。最多 5 MiB、1000 道菜谱、20000 条用餐记录；删除历史上限为 10000 道菜谱、100000 条记录。

个人索引每账号一个文档，保存 `revision/fileID/updatedAt`；家庭数据使用独立家庭文档及成员映射，按当前成员身份读取同一家庭快照。大体积快照与照片放云存储。服务端 SDK 不受客户端安全规则约束，必须保留成员、scope、归属和文件路径校验，不提供任意 fileID 的下载代理。

## 保留与回收

当前不自动删除旧快照或照片，以免并发读取、离线设备和旧版本引用丢失。上线后的垃圾回收应独立设计：标记所有仍受保留策略保护的快照及其照片引用，经过明确的保留窗口，再由管理端清理未引用对象。不能在单次同步提交成功后立即删除旧文件，也不能只依据当前设备的照片列表删除云端内容。

参考：[微信服务端 SDK](https://github.com/wechat-miniprogram/wx-server-sdk)、[事务](https://docs.cloudbase.net/database/transaction)、[数据库权限](https://cloud.tencent.cn/document/product/876/41802)、[云存储规则](https://docs.cloudbase.net/storage/security-rules)。
