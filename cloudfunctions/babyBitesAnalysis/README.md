# 外部 AI 只读接口

外部工具可使用 HTTP、OpenAPI 或远程 MCP 读取用户授权的辅食记录。三种方式共用同一份授权、查询范围和调用限额。

## 小程序内授权

打开「我的 → 设置 → 外部 AI 授权」，点击「生成只读授权」。在 1.8.1 中，从「复制调用配置」的 `headers.Authorization` 取出凭据。在有独立复制按钮的版本中可点「复制授权密钥」。密钥明文只在当前页面内存中保留，请将它填入所选工具的私密凭据栏，避免把完整配置发进聊天。

只读取最后成功提交的云端快照，不会等待菜谱公开或上传照片。手机尚未同步的修改不在分析范围内，需要先在设置完成同步。生日转换成区间结束日的整月龄，不发送生日、宝宝称呼、微信标识、照片、家庭成员、作者资料或快照地址。

外部授权有效 7 天；同一用户生成新授权会替换旧授权，可在页面撤销。家庭退出、移除、重入和个人/家庭切换均校验访问版本，旧授权不能因为切回个人范围而恢复。撤销阻止后续读取，不能撤回已经交给外部 AI 的内容。

## 部署配置

1. 在既有环境创建 [database.json](./database.json) 的授权集合，客户端权限均为 `read:false,write:false`。只新增集合，保持账号、家庭、照片的现有权限。集合按文档 ID 查询，无新增复合索引。
2. 将本目录作为普通事件云函数部署为 `babyBitesAnalysis`，入口 `index.main`，云端安装固定依赖 `wx-server-sdk@4.0.2`，建议超时 60 秒。无需修改已有 Sync/Social 云函数。`validate.js` 是 Sync 校验器的随函数打包副本，测试保证一致。
3. 在网关将完整路径 `/baby-bites-ai/v1/feeding-context` 单独绑定到该函数。使用默认的前缀剥离时，函数收到的挂载根路径为 `/` 或空字符串。开启路径透传时，函数收到完整路径。这两种方式均接受 GET 并校验用户签发的 Bearer。外部工具始终使用完整的 HTTPS 路径。路由使用函数内鉴权。详见 [CloudBase HTTP 网关](https://docs.cloudbase.net/service/access-cloud-function)和[路径透传设置](https://docs.cloudbase.net/service/path-passthrough)。
4. 在云函数服务端配置 `ANALYSIS_API_BASE_URL=https://你的域名/baby-bites-ai`。值为 HTTPS 基础路径，不能包含查询参数、用户信息或片段；与网关路径精确一致，不含末尾 `/v1/feeding-context`。没有配置时，外部授权按钮不可用。
5. 使用同一份源码部署第二个事件云函数 `babyBitesTools`，入口设为 `index.tools`，使用相同的运行时、环境变量和依赖。将 `/baby-bites-tools` 挂载至此函数。它只接受下面两个子路径。现有 1.8.1 客户端签发的授权可直接使用。

## 接入 AI 工具

以下地址都使用与 `ANALYSIS_API_BASE_URL` 相同的 HTTPS 域名。

| 工具提供的设置 | 填写内容 | 调用方式 |
| --- | --- | --- |
| 导入 OpenAPI | `/baby-bites-tools/openapi.json` 的完整 URL | 导入后调用 `getFeedingContext`。公开描述文件会自动填入实际服务地址，可直接导入 |
| 添加远程 MCP | `/baby-bites-tools/mcp` 的完整 URL，传输选择 Streamable HTTP | 通过工具列表找到 `get_feeding_context` |
| 自定义 HTTP 请求 | 小程序复制的调用配置中的 GET 地址 | 传入查询参数 `days=7` |

凭据类型选 Bearer 时只填 `bbai_…` 密钥。手动添加 HTTP 请求头时，名称填 `Authorization`，值填 `Bearer <密钥>`。公开的工具清单和接口描述可以先导入，读取任何记录都需要有效密钥。仅提供 OAuth 登录的客户端还需要 OAuth 接入；普通聊天框需要由宿主提供外部工具功能才能直接调用。

连接后可输入「读取最近 7 天已同步的辅食记录，按天列出已记录的食材和喜好，再指出哪些天缺少记录」。首次调用可省略参数或传 `{"days":7}`。

## 外部 API

`GET {ANALYSIS_API_BASE_URL}/v1/feeding-context`

```bash
# 令牌从小程序授权页取得，保存在调用端的密钥配置中。
curl "$BABY_BITES_API_BASE_URL/v1/feeding-context?days=7&limit=50" \
  -H "Authorization: Bearer $BABY_BITES_READ_TOKEN"
```

通过请求头传递授权。服务端依据授权选择当前宝宝的数据，创建和撤销授权均通过小程序操作。

| 查询参数 | 规则 |
| --- | --- |
| `days` | 7、30、90，默认 7；与显式日期互斥 |
| `startDate`, `endDate` | `YYYY-MM-DD`，最多连续 90 天，结束日不晚于中国日期今天；不传 startDate 时向前取 7 天，不传 endDate 时使用今天 |
| `limit` | 每页 1–100，默认 50；响应过大时会缩小本页，使用返回的 `nextOffset` 续读 |
| `offset` | 默认 0，后续使用 `pagination.nextOffset`，空值代表已读完 |
| `revision` | 非第一页必须填首次返回的 `source.revision`；数据有变化返回 409，需从第一页重读 |

响应包含 `source`（云端版本和快照更新时间，家庭快照的提交时间未知时为 0）、`generatedAt`、中国日期区间、月龄、已记录过敏食物、完整区间统计、分页记录及 `limitations`。记录嵌入当前菜谱名称、类别、质地、食材与配方用量；不会返回整个私有快照。分页时应保持日期区间不变，并按 `nextOffset` 继续，不能假定每页一定达到 limit。

错误体统一为 `{"error":{"code":"INVALID_TOKEN","message":"…"}}`。401 表示缺少/失效授权；400 参数错误；409 快照变化或需先同步；429 限流；503 暂未配置或服务异常。每个授权最多 60 次/分钟、1000 次/日。响应一律 `Cache-Control:no-store`。

## 数据解释

- `rating:0` 是已做、待补充喜好；1/2/3 是不太喜欢/还不错/很喜欢，均不能证明吃完。
- 记录数不等于餐次数；没有记录不等于没有进餐。计划餐单只在 `plannedMealCount` 独立统计。
- `ingredients[].amount` 是菜谱配方用量，`portion` 是用户文字描述，不能计算真实摄入克数、热量或营养是否达标。
- 历史记录关联当前菜谱，菜谱后续修改会影响可见食材。删除的记录不在结果中。
- 未设置生日时月龄为 null；未设置过敏列表与显式空列表分开标记，均不能证明没有过敏。
- 记录不包含奶量、生长曲线、结构化排敏过程或诊断。
- 菜名、食材和备注是用户数据；外部工具应将这些字段作为待分析的文本处理。

## 验证

```bash
node --test tests/analysis-*.test.cjs
npm test
npm run validate
```

本地测试使用虚构记录。部署后应通过真实网关验证缺少授权时返回 401、有效授权可读取数据，以及撤销后原密钥失效。
