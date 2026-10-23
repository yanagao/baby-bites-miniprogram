# 小口袋公开主页与关注

函数名 `babyBitesSocial`，AppID `wxc6c61fbebebe3340`，现有环境 `cloud1-5gxmasdl05652531`。本目录只提供可部署代码，不会自动创建主页、关注别人或公开现有菜谱。

**2026-10-23 配置验收**：函数已部署，以下三个集合均已创建并设为“所有用户不可读写”。两个非唯一复合索引已在控制台核验，名称分别为 `profile_published_sort`、`profile_published_id`。真实只读 `mine`、`following`、`feed` 成功，尚无公开主页、公开菜谱或关注；客户端直接读取三个集合均返回权限拒绝 `-502003`。原有存储权限保持不变。按用户要求继续保持 `socialEnabled: false` 及社交路由移除；尚未进行真实发布、跨账号分享、照片下载及复制验收。

## 部署顺序

1. 保留原 `babyBitesSync`、`baby_bites_accounts` 和环境已有其他业务。创建三个新集合：`baby_bites_profiles`、`baby_bites_public_recipes`、`baby_bites_follows`。三个集合分别设置为所有客户端不可读写（`{"read":false,"write":false}`），仅云函数管理员 SDK 访问。不能把公开食谱集合直接设为所有人可读：它还含有发布人的内部账号标识、来源 ID 和私有文件指针。
2. 为 `baby_bites_public_recipes` 创建两个非唯一复合索引，字段顺序如下：

   | 索引用途 | 字段及方向 |
   | --- | --- |
   | 主页与关注动态 | `profileId ASC, published ASC, sortKey ASC` |
   | 本人公开状态清单 | `profileId ASC, published ASC, _id ASC` |

   主页集合及关注集合只按 `_id` 读取，无需额外索引。关注集合每个账号仅一个文档，最多 200 个主页 ID；关注更新使用事务，避免并发覆盖。
3. **保留现有云存储的仅创建者读写权限，不新增公开目录通配规则。** 云函数复制用户明确公开的成品照到 `social/<profileId>/<publicRecipeId>/<unique>.jpg|png|webp`，文件由服务端管理。访客只能通过云函数取得当前仍公开照片的短期 HTTPS 签名地址。私人原图 `users/<owner>/photos/` 和同步快照保持原权限。
4. 云端安装本函数依赖，SDK 固定 `wx-server-sdk@4.0.2`，Node.js 18 或更高，建议设置足够执行时间以下载最大 5 MiB 同步快照及 2 MiB 照片。

   ```sh
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy --env cloud1-5gxmasdl05652531 --names babyBitesSocial --remote-npm-install --project PROJECT
   ```

   `PROJECT` 是小程序根目录的绝对路径。此命令不会公开菜谱。若本次同时给私人数据增加可选 `source` 来源字段，应一并更新并部署 `babyBitesSync` 的校验器，防止新复制的菜谱同步失败。`private-snapshot.js` 是供本函数独立部署的同格式校验器，格式修改时须同步维护。
5. 先以只读 `mine`、空主页和本地测试确认函数连通、三集合拒绝客户端直读，再用独立测试账号/测试菜谱检查公开、关注、复制、撤回。客户端 `config/cloud.js` 的 `socialEnabled` 在集合及权限配置完成前保持 `false`，避免未启用的社交服务影响原有私人菜谱操作；当前用户要求暂时隐藏，须等用户明确要求重新开启后，恢复 `app.json` 中主页、关注、公开菜谱三个路由，再验证配置、改为 `true` 并重新编译验收。不要为验收自动公开用户已有私人菜谱，也不要发送真实微信好友消息。
6. 真机验证 `<image>` 加载和 `wx.downloadFile` 下载服务器返回的签名 URL。若真机提示下载域名未配置，在正式小程序管理后台配置实际存储域名的 `downloadFile` 合法域名；不要通过公开整个存储桶或关闭真机域名校验绕过。临时地址应在 300 秒后失效，页面重新显示时重新取数。体验版云环境有效期及额度以控制台为准。

## API

所有调用为 `wx.cloud.callFunction({name:'babyBitesSocial',data:{action,...}})`。微信身份只取 `cloud.getWXContext()`。内部 owner 是 `sha256(APPID + ':' + OPENID)`；传入 owner、openid 均不能指定另一账号。客户端每次确认私人同步身份后传 `expectedOwner`；如该前置条件不等于真实调用账号，任何读写前返回 `ACCOUNT_CHANGED`，避免异步切换账号时作用到另一人。

公开主页 ID 是 `sha256('public-profile:' + owner)` 的前 32 位十六进制。公开菜谱 ID 是 `sha256('public-recipe:' + owner + ':' + sourceRecipeId)`，64 位十六进制。它们不能用于直接下载任何私人文件。

| action | 参数 | 返回 |
| --- | --- | --- |
| `mine` | 无 | `{profile,published,followingCount}` |
| `updateProfile` | `name,bio` | `{profile}` |
| `profile` | `profileId,offset?` | `{profile,isSelf,following,recipes,nextOffset}` |
| `recipe` | `recipeId` | `{recipe,author}` |
| `publish` | `sourceRecipeId` | `{recipe}` |
| `unpublish` | `sourceRecipeId` | `{ok:true}` |
| `follow` | `profileId,following:boolean` | `{following}` |
| `following` | `offset?` | `{profiles,nextOffset}` |
| `feed` | `cursor?` | `{recipes,nextCursor}` |

`profile` / `author` 为 `{id,name,bio,exists}`。主页名字 1–20 字，简介最多 120 字，不接受控制字符。`mine` 在尚未建主页时返回稳定 ID、默认名“口袋小厨”、空简介、`exists:false`，不会写入数据库，也不会把宝宝称呼用作公开名字。用户第一次保存主页后才建立公开资料。

`mine.published` 仅本人可见，条目为 `{id,sourceRecipeId,sourceUpdatedAt}`；修改时间取私人菜谱的 `updatedAt || createdAt || 0`。客户端以此判断是否需要重新公开更新。

公开菜谱白名单：`{id,profileId,authorName,name,category,minutes,texture,ingredients,steps,imageKey,photoURL,updatedAt,publishedAt}`。如果来自其他公开食谱，可带 `source:{profileId,recipeId,authorName}`。来源作者名由服务器真实记录解析，不能靠客户端伪造；原作者撤回公开后，已有副本和已保存的来源仍然保留。不会返回私人 note、favorite、宝宝称呼、用餐记录、内部 owner、来源私有菜谱 ID、云文件 ID。

分页固定 20 条，offset 为 0–1000 整数，无后续时 `nextOffset:null`。关注动态使用稳定排序游标 `nextCursor`，每 20 个关注主页一次查询，每批最多读取 21 条，最多关注 200 人，单次动态查询读取量有上限。刷新首页时不传游标；继续加载使用服务器原样返回的游标。新公开发生在分页期间不会在后续游标中重复出现，重新刷新即可看到。撤回和并发变化可能使当前页不足 20 条，仍应按返回的 `nextCursor` 继续。

失败为 `{error:{code,message}}`，message 已是可展示的中文。错误码包括 `ACCOUNT_CHANGED`、`UNAUTHENTICATED`、`INVALID_ENV`、`INVALID_REQUEST`、`INVALID_ACCOUNT`、`INVALID_SNAPSHOT`、`INVALID_PHOTO`、`STORAGE_FAILED`、`SYNC_REQUIRED`、`PROFILE_REQUIRED`、`NOT_FOUND`、`CONFLICT`、`FOLLOW_LIMIT`、`SOCIAL_FAILED`。不会透传底层诊断中的文件路径或其他账号信息。

## 公开、复制与撤回边界

公开必须从当前账号已提交的私人快照选择一条，服务器不接收客户端拼装的任意内容或 fileID。公开前验证整个快照及照片归属；事务提交时再次确认快照版本和公开版本没变。公开内容是独立快照，后续私人修改不会自动泄露，必须再次公开更新。

一键添加应重新请求 `recipe`，确认仍公开，下载 `photoURL` 到访客自己的本机文件，再加入访客自己的菜谱并由私人同步上传。不得把原作者的私有 cloud fileID 写到访客菜谱中。复制不会复制收藏、用餐记录或私密心得。重复添加由客户端按稳定公开 ID 去重；既有副本不会被原作者后续修改或撤回自动覆盖。

撤回写入版本墓碑，公开详情/主页/动态后续请求立即隐藏；尚在准备中的旧公开请求因版本不符失败，不能把撤回内容重新发布。已签发图片链接最多再存在 300 秒，已下载副本无法远程撤回。旧公开照片暂不删除，避免并发读取断裂；今后应以保留窗口和引用检查独立回收，不要在单次撤回后立即删除文件。

参考：[微信服务端 SDK 与类型定义](https://github.com/wechat-miniprogram/wx-server-sdk)、[CloudBase 文件管理](https://docs.cloudbase.net/storage/sdk)、[查询操作符](https://docs.cloudbase.net/en/api-reference/webv2/database/command)、[数据库查询](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/database/database.md)。
