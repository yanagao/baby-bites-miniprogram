# 默认菜谱图片服务

`babyBitesAssets` 只为 21 张静态示例菜谱图片生成访问链接。AppID 为 `wxc6c61fbebebe3340`，环境为 `cloud1-5gxmasdl05652531`；使用 Node.js 16.13 兼容语法与 `wx-server-sdk@4.0.2`。不读取或写入账号、主页、菜谱、快照、数据库，不上传或删除文件，也没有 seed、初始化或任意路径代理入口。现有仅创建者可读写的存储规则保持不变。

## 接口

客户端仅传 `{action: "catalog"}`。兼容已实测确认的微信平台附加字段 `userInfo`、`tcbContext`，两者的值完全忽略、不采用也不返回；除此以外的额外字段均拒绝。每次调用（包括命中缓存）都只使用 `cloud.getWXContext()` 校验真实 `OPENID`、固定 `APPID` 和 `ENV`；伪造这两个事件字段不能补充或覆盖鉴权上下文，不接受请求内的 fileID、路径、环境或 TTL。错误响应仅包含错误码和安全文案，临时部署诊断已移除。

成功返回：

```js
{
  version: 'recipe-covers-v1',
  expiresAt: 1790000000000, // 本次签名开始时间 + 55 分钟，毫秒时间戳
  files: [{key: 'dish:pumpkin-millet', url: 'https://…', sha256: '…', md5: '…', bytes: 64399}]
}
```

`manifest.json` 是部署时固定清单，包含 `version`、`env` 和恰好 21 项 `files: [{key, sha256, md5, bytes, fileID}]`。key 必须在代码的固定菜谱白名单内且不得重复，字节数必须在 1–204800 之间。fileID 必须属于上述环境，对应路径必须严格为 `public/recipe-covers/v1/<菜谱ID>-<sha256前16位>.jpg`。部署前填入上传返回的真实 fileID，不能自行拼接存储桶标识或保留占位值。

一次 `getTempFileURL` 最多签 21 项，请求 `maxAge: 3600`；返回值须逐项匹配 fileID、成功状态、固定资源路径与 HTTPS TCB/COS 主机，不能带 URL 用户信息、非标准端口或 fragment。若 SDK 返回有效期，它必须覆盖 55 分钟客户端有效期。任意项缺失、重复、失败或不合法时整次返回 `ASSETS_UNAVAILABLE`，不返回部分目录或底层错误。成功 DTO 不包含 fileID、OPENID、APPID 或其他私有资料。

成功目录在单个函数实例内缓存 50 分钟，并发调用共享同一签名请求；命中缓存保持原 `expiresAt`，不会滑动延期。失败不缓存，后续调用可重试。错误码为 `UNAUTHENTICATED`、`INVALID_ENV`、`INVALID_REQUEST`、`ASSETS_UNAVAILABLE`。客户端只把默认图用于展示，并将图片缓存放在业务快照以外；不能写入菜谱的用户 `photo` 字段。

## 准备与部署

1. 使用已授权的小程序 SDK 将原始 21 张 JPEG 上传到上述固定路径，保留每张原始文件的 SHA-256、MD5 和字节数。不要改变全局存储权限。将上传返回的真实 fileID 填入 `manifest.json`。
2. 核对清单完整性和云端下载字节哈希；运行 `node --test tests/asset-function.test.cjs`。此函数没有 OpenAPI 调用，无需新增 `config.json` 权限。
3. 由负责发布的操作者部署：

   ```sh
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy --env cloud1-5gxmasdl05652531 --names babyBitesAssets --remote-npm-install --project PROJECT
   ```

4. 核对函数状态、运行时和实际超时配置，读取 catalog 验证 21 个结果，再由客户端下载并检查字节数、MD5 和图片解码。客户端完整下载时长与云函数执行时长分别评估，不依据其他函数的配置强制设置超时或内存。
5. 只读验证任意 fileID/路径请求被拒绝、业务快照指纹前后不变；跨账号私人文件读取仍需使用独立测试账号验收。21 张 JPEG 原文件归档在小程序包外的 [工作区目录](../../../output/cloud-recipe-covers/source/)，不再包含在 `recipe-media/food/`。回滚时使用归档与清单核对原始字节。

## 已验证状态（2026-10-30）

函数已部署为 **Active**，运行时 **Node.js 16.13**，执行超时 **3 秒**。微信开发者工具的实际目录请求与 21 张图片下载、缓存全流程约 **4 秒**，此数包含客户端下载，不是单次云函数耗时。21 张图片的缓存字节数、MD5 与 600 × 400 解码均通过；再次 `prepare()` 的 `catalogCalls: 0`、`downloads: 0`，任意 fileID / 路径请求返回 `INVALID_REQUEST`，业务数据指纹前后相同。完整结果见 [catalog-qa.json](../../../output/cloud-recipe-covers/catalog-qa.json)。

客户端先逐项校验独立缓存，再为缺失图片后台请求目录并下载；有可用来源的图片立即展示，不等待全部 21 张。缓存或云端 URL 仅用于展示，不进入用户 `photo`、私人快照或备份；食材插画与 Logo 仍在本地。此次验收仅覆盖开发者工具与实际云服务，不代表真机、双账号、签名链接实际到期或最终代码质量扫描已通过。

SDK 参数依据 [微信服务端 SDK 类型定义](https://github.com/wechat-miniprogram/wx-server-sdk/blob/master/index.d.ts)；私有文件通过临时链接访问的权限说明见 [CloudBase 存储基础权限](https://docs.cloudbase.net/storage/data-permission)。链接是短期访问凭证，应避免记录到日志；实际过期表现仍需部署后验收。
