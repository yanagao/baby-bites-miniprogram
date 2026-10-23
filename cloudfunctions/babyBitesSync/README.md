# 小口袋账号同步云函数

正式 AppID：`wxc6c61fbebebe3340`；现有环境：`cloud1-5gxmasdl05652531`；函数名：`babyBitesSync`。本目录不自行开通云开发或创建付费环境。测试号不支持账号同步。

2026-10-23 已部署并验证：账号集合为所有客户端不可读写，存储原规则为仅创建者读写且未改动。正式微信账号完成真实上传及再次下载，独立空缓存通过真实云接口恢复了 9 道菜谱、4 条记录和 1 张照片。客户端直接读取账号集合返回权限拒绝。尚未使用两部手机/两个真实微信账号交叉验收。该环境另有其他用途的云函数，后续仍须保留其既有存储访问方式。

## 部署

1. 在微信开发者工具打开 AppID 为 `wxc6c61fbebebe3340` 的项目，选中已开通环境 `cloud1-5gxmasdl05652531`。客户端 `config/cloud.js` 的 `env` 保持空字符串，直到集合和存储权限确认完成；空环境时不上传用户数据。
2. 在云开发控制台创建集合 `baby_bites_accounts`。将集合的安全规则设为仓库 `cloud/database.rules.json` 的内容：客户端不可直接读写，只允许服务端访问。
3. 确保 `users/<owner>/snapshots/` 和 `users/<owner>/photos/` 仅允许文件创建者本人读写。`cloud/storage.rules.json` 是**独占环境模板**；本环境存在其他业务，需先读取原规则与实际使用路径，合并权限后应用，不能直接全局改为私有。经典安全规则支持 `/^public\\//.test(resource.path)` 等路径白名单，以及 `resource.openid == auth.openid` 所有者检查；不支持对 `.test()` 结果使用 `!` 取反，因此不能猜写“所有非 users/ 都公开”。应明确保留既有公开目录和原有写入条件，再验证小口袋目录私有；如果无法确认原有目录用途，应先停留在配置阶段。规则发布可能需要几分钟生效；验收须确认本人可上传和下载、另一微信账号不可下载，并确认旧业务仍可访问原文件。
4. `project.config.json` 指定 `"cloudfunctionRoot": "cloudfunctions/"`。右键 `babyBitesSync`，选择“上传并部署：云端安装依赖”，或使用已开启服务端口的官方 CLI：

   ```sh
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud env list --project PROJECT
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy --env cloud1-5gxmasdl05652531 --names babyBitesSync --remote-npm-install --project PROJECT
   ```

   将 `PROJECT` 替换为绝对项目路径（有空格时加引号）。不要部署到其他项目或环境。SDK 固定为 npm 官方稳定版 `wx-server-sdk@4.0.2`，依赖由锁文件固定。云函数使用 Node.js 18 或更高版本，适当配置超时以完成最大 5 MiB 快照下载。
5. 验证权限后，把 `config/cloud.js` 的 `env` 设为 `cloud1-5gxmasdl05652531`，在受控测试中验证身份读取、原有数据迁移、第二台设备恢复、离线修改后同步、两个设备同时修改和账号隔离。启用后同步范围包括宝宝称呼、菜谱、收藏、用餐记录和照片；微信昵称及头像不属于身份识别必需信息。

## 账号与迁移行为

同一微信账号、同一 AppID 和同一环境对应同一份数据；不同微信账号隔离。首次成功识别微信账号后，客户端将未绑定的旧 `baby-bites-v1` 内容合并到该账号，保留原数据并写入一次性归属标记；之后切换账号不会把这份旧数据再次上传给别人。其他 AppID 或网页版的数据需要先导出、再由用户导入备份。

修改先落地本机，再在前台、联网恢复及编辑后同步；「设置 → 微信账号同步」可手动重试。离线时保留本机修改，首次在新设备恢复需要网络。多设备以条目 ID 和修改时间合并，删除历史避免旧缓存恢复已删内容；同一条目的冲突按较新修改处理，不逐字段拼接。客户端提交时使用云端 revision；不匹配则读取新版本重新合并，不直接覆盖。

## 协议与权限

客户端以 `wx.cloud.callFunction({name:'babyBitesSync', data:{action:'identity'}})` 查询当前账号。用户标识为 `sha256(APPID + ':' + OPENID)`；这些值只从 `cloud.getWXContext()` 读取，客户端传入的 owner/openid 不参与授权。

- `identity` 返回 `{owner, revision, fileID}`；新账号为版本 `0`、空 `fileID`，查询不会写数据库。
- `commit` 参数为 `{action:'commit', baseRevision, fileID}`。先下载并校验快照，再在数据库事务内比较版本号。成功返回更新后的指针；冲突返回 `{conflict:true, owner, revision, fileID}`，不会覆盖其他设备的新版本。
- 失败返回 `{error:{code,message}}`，不暴露底层存储路径或第三方账号标识。
- 照片路径为 `users/<owner>/photos/<unique>.jpg|png|webp`；快照为 `users/<owner>/snapshots/<unique>.json`。每次上传必须使用新文件名，后续不要覆盖已经发布的快照。客户端负责上传、下载，服务端只读取属于当前环境、当前账号目录下的快照。
- 快照结构为 `{version:1,data:{version:1,nickname,profileUpdatedAt,recipes,logs},deleted:{recipes:[{id,updatedAt}],logs:[{id,updatedAt}]}}`。最多 5 MiB、1000 道菜谱、20000 条用餐记录；删除历史上限为 10000 道菜谱、100000 条记录。

数据库只有一个每账号文档，保存 `revision/fileID/updatedAt`，大体积快照与照片放云存储。服务端 SDK 不受客户端安全规则约束，必须保留函数中的归属与文件路径校验，不应新增任意 fileID 的下载代理。

## 保留与回收

当前不自动删除旧快照或照片，以免并发读取、离线设备和旧版本引用丢失。上线后的垃圾回收应独立设计：标记所有仍受保留策略保护的快照及其照片引用，经过明确的保留窗口，再由管理端清理未引用对象。不能在单次同步提交成功后立即删除旧文件，也不能只依据当前设备的照片列表删除云端内容。

参考：[微信服务端 SDK](https://github.com/wechat-miniprogram/wx-server-sdk)、[事务](https://docs.cloudbase.net/database/transaction)、[数据库权限](https://cloud.tencent.cn/document/product/876/41802)、[云存储规则](https://docs.cloudbase.net/storage/security-rules)。
