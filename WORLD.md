# 家庭任务、工作区与跨端交付 · 初版

用户在任何入口下指令，产物按用户指定的目的地发送。例如在 QQ 说“把文件发到 dc”，在微信 Clawbot 说“语音发到 tg”。来源平台不决定结果平台；文件不会被替换成聊天正文，语音不会被悄悄降级为音频附件。目的地未绑定、能力不足或大小超限会明确保留失败/阻止回执与可领取产物。

本版增加五项可运行能力：后台成员任务、跨端收件箱、带检查点的任务交接、独立成员工作区、事件与时间通知。没有用额外意图模型处理每句话，也没有常驻多成员闲聊。

## 手机上怎么用

首次部署并启动网关后，打开服务器下的 `/home`。输入网关 Key，即可管理任务、成员文件、收件箱、投递回执、通知和平台绑定。Key 仅存在当前页面内存中。凭据仍在 `/mcp` 页面加密保存。

1. 在 `/mcp` 保存平台令牌引用，例如 `dc-token`、`tg-token`、`qq-token`、`openclaw-token`。引用名可以自定。
2. 在工作台“平台绑定”填写 accounts/destinations；可从 `channels.example.json` 复制。所有数字和 Weixin ID 都是占位值，需要填写用户自己的真实账号/会话 ID。
3. 不接收入站的平台保持 `inbound: false`，仍能出站发送。需要原生接收时启用对应账号。保存后接收端重新连接，出站配置立即生效。
4. 在聊天中说清任务和目的地，或在工作台上传文件后选择目的地发送。

也可设置 `CHANNELS_PATH=./channels.local.json` 从服务器文件加载。配置文件在每次启动时优先于数据库内的手机配置；使用手机管理时不要设置这个覆盖项。

## 目的地和真实身份

每个平台账号包含 `id`、`platform`、`ownerIds`、凭据引用与可选平台地址。`ownerIds` 是平台事件里的真实发送者 ID，不使用昵称或正文“我是主人”。本版只服务一个家庭所有者，不把平台群友当成所有者。

目的地包含唯一 `id` / 别名、`accountId`、平台会话 `target`、入站对应 `roomId` 和 `capabilities`。例如给唯一的 Discord 频道起别名 `dc`，给 Telegram 私聊起别名 `tg`。两个会话不能同时占用同一个别名，模型不能猜一个默认收件人。

| 平台 | target 配置 | 原生出站 | 原生接收 |
| --- | --- | --- | --- |
| Discord | `channelId`；私信也填写真实 DM 频道 ID | REST 文字、文件/图片附件、原生语音消息 | Gateway WebSocket、Identify、心跳、Resume 与重连；需开启 Message Content intent |
| Telegram | `chatId`，可加 `threadId` | sendMessage / sendDocument / sendPhoto / sendVoice，multipart 上传真实文件 | 默认 getUpdates 长轮询并保存 offset；设置 webhookSecretRef 后改用鉴权回调 |
| QQ OneBot | `userId` 或 `groupId` | HTTP API、文本段、图片/record 段、上传文件扩展 | `/ingress/<accountId>` HTTP 事件上报，验证 X-Signature；未实现 OneBot WebSocket 接收 |
| 微信 Clawbot | `userId`，账号指定 OpenClaw channel | 通过已有 OpenClaw 的 `/tools/invoke` 调用 message 工具 | 可把其模型上游接到本网关 `/v1`；也提供单独鉴权的规范化事件桥接入口 |
| 普通客户端 | 空 target | 收件箱领取；`available` 表示可领取，未伪称推送成功 | OpenAI 兼容聊天接口 |

一条指令可说“文件发到 dc，语音发到 tg”，逐项绑定类型和目的地。被否定或只是在引用里的发送目的地不构成授权。没有指定目的地的任务完成后进入收件箱；通知可沿用当前房间最近一次已识别的来源目的地，无法识别来源时仅进入收件箱。明确目的地不会随着用户后来换平台而改变。

用户可以明确要求把自己当前有权读取的文件发到另一个已绑定目的地，即使目的地的入站房间不同。这个授权只针对该次交付，不开放原工作区、个人记忆或目标房间历史。后台执行者不能自行更改目的地。

## 后台任务与接手

普通聊天可调用 `task_start`，指定目标、成员和可选交付目的地/类型，立即获得任务 ID。后台最多同时执行两个任务，同一成员一次只执行一个后台任务；前台聊天使用独立调用，不排在任务队列之后。真实模型服务的并发/限速仍可能影响等待时间。

执行者可以使用自己的工作区、语音生成和当前成员/房间获准的 MCP 工具。默认最多 20 个回答/工具轮、五分钟；到轮数上限会暂停，超时/失败保留进度。不向后台开放“再创建任务、扩权、分享私人文件、提前对外发送”的控制工具。结果由程序按原用户授权投递。

`task_checkpoint` 记录实际完成部分、卡点和真实文件 ID。任务运行记录每轮持久化；旧版本记录放在 `task_runs`，原文不靠摘要替换。暂停/继续、取消和交接都更新执行版本，旧执行者返回的迟到结果不能覆盖任务或发送产物。

用户说“把这个任务交给雾岛纪接手”，模型调用 `task_handoff`。多个进行中任务无法明确对应时，需指明任务 ID。新成员得到目标、检查点、任务产物、带作者的交接记录和自己有权限的上下文；不会继承前任的私人记忆、完整私人上下文或未纳入任务的草稿。任务输入与任务产物分开保存，不把参考文件自动当成果发出去。产物作者保持不变。聊天接话成员的切换与后台任务接手是两个独立动作。

状态：`queued` / `running` / `paused` / `succeeded` / `failed` / `cancelled`。网关重启时运行中的任务变为暂停，需要用户明确继续；未确认结果的外部调用补入“结果不明，未自动重试”的工具结果。成功结果与交付之间的中断可从持久状态补齐，通过去重键避免重复交付。

本版执行的是模型与已授权工具任务，没有通用 shell/代码执行工具。运行项目测试需要配置相应 MCP 或外部测试服务；外部服务可通过鉴权 `/api/signals` 上报结果，驱动通知。

## 成员工作区

每个稳定成员 ID 有独立物理目录；模型操作逻辑文件名和 artifact ID，不能选择服务器绝对路径。聊天保留输入文件引用，后续“刚才那个文件”仍可对应原文件。文件不可变，重写同名草稿产生新版本，旧文件按 ID 可读；元数据保存作者、字节数、SHA-256、父文件、共享范围和创建时间。读取会检查文件类型、内容哈希、符号链接与路径范围。

`workspace_list/read/write/publish` 支持草稿、Markdown、代码、JSON 收藏清单等。发布需要用户当前明确要求，扩大的只是指定文件的可见性。总控不能写成员工作区。共享文件在作者工作区的名字和原作者不会改成接收者。

每个上传最多 25 MiB。文本工具每次写入最多 100000 字符；大文件用二进制上传接口。素材与生产数据都在 `WORLD_DATA_DIR` 下，和 SQLite 一起备份。

## 文件和语音

MCP 返回的图片/音频、HTTP 上传以及原生平台下载的附件可成为持久 artifact。交付传文件 ID，不传任意本地路径。QQ 文件接口需要网关与协议端有共享目录：将 `WORLD_DATA_DIR/outgoing` 挂到协议端 `providerFileRoot` 指定的位置。图片和语音使用 OneBot 的 base64 消息段，不依赖这个文件挂载。

语音生成有两条路径：使用 MCP 产生的音频，或配置 `VOICE_SERVICE_URL` / `VOICE_API_KEY` / `VOICE_MODEL` / `VOICE_VOICES` 的兼容语音服务。成员音色由服务器配置；未配置就明确返回 `speech_not_configured`，不伪造音频。它不代表实现了语音识别或实时通话。

系统 **ffmpeg** 会把本地音频转换成 Ogg/Opus，计算真实时长与 256 点波形。禁用外部输入协议，只处理已授权本地文件；单条最多十分钟。TG 使用 sendVoice，Discord 设置 `IS_VOICE_MESSAGE`、duration_secs、waveform 和单音频附件，不附带 content。转换失败保留错误，不悄悄改成普通文件。微信出站是否能展示为原生语音取决于已安装插件的版本能力，示例默认未启用微信 voice。

客户端不用强求原生媒体渲染：可以只聊天，也可以从 `/api/inbox` 取得 artifact ID，再鉴权下载 `/api/files/:id`。客户端类型的目的地放入可领取收件箱，不启动假推送。

## 微信 Clawbot / OpenClaw 接法

沿用现有登录与 Weixin 插件，不另写二维码登录或复制其实现。它可以继续负责接收微信消息，将主模型配置为本网关的 OpenAI 兼容入口：Base URL 为 `https://你的网关/v1`、模型 `family`、Key 为网关 Key。需要识别通知回程时，可在服务商自定义请求头填 `X-Destination-Id: wechat-home`。

向微信投递时配置一个 `platform: openclaw` 账号，baseUrl 是已有 OpenClaw 网关，tokenRef 引用其独立 API 凭据，channel 为 `openclaw-weixin`，destination.target.userId 为已配对的真实用户。OpenClaw 必须允许该调用方使用 message 工具及指定 channel/target；返回策略拒绝会保留失败/结果不明，不绕过其策略。

文件通过 `PUBLIC_BASE_URL` 下的短时签名媒体 URL 交给 OpenClaw 下载，不把服务器绝对路径发过去。链接十分钟有效，不出现在模型的工具定义中；生产环境使用 HTTPS。需要原生 Weixin 媒体支持的插件应预先登录并具备有效 context token。当前没有独立实现 Tencent iLink 登录、媒体加密上传或登录续期。

如使用自定义入站桥，设置账号 `inbound: true`、独立 `webhookSecretRef`，用 `Authorization: Bearer <桥接凭据>` 向 `/ingress/wechat` POST：

```json
{"id":"平台唯一消息ID","senderId":"绑定的真实发送者ID","destinationId":"wechat-home","text":"生成一段语音发到tg"}
```

桥接密钥只由用户管理的桥服务持有，不能发给群友。本网关仍检查 senderId 与 ownerIds。这个规范化入口不是声称 OpenClaw 会自动发送该格式；可选择模型上游接法，无须再写这个桥。

## 可靠投递与通知

投递状态：`queued` → `sending` → `sent`，明确失败为 `failed`，结果不明为 `unknown`，能力/目的地变化阻止为 `blocked`，客户端待领取为 `available`。同目的地串行，不同目的地并行。网络超时、异常响应或进程中断不会自动重发不确定消息。只有明确 429 限流可有限重试，最多四次；结果不明需要用户核对后显式 `confirmUnknown`。

任务完成结果写收件箱，投递有独立回执。重复调用同一原用户指令的同一交付、任务/通知提交不会不断生成副本；没有声称所有外部平台都提供严格 exactly-once 发送。

`notify_control` 可按用户要求关闭规则；`notify_when` 支持任务成功/失败、MCP 任务结束、鉴权外部 signal 和指定时间。match 逐字段精确匹配，默认只触发一次；循环通知需要用户明确要求周期/每次。事件游标与去重键持久化。离线期间错过多次周期时合并为一次，不补一串过期提醒。

quietHours 只约束主动规则通知，使用配置时区。勿扰期间结果仍入收件箱，推送留在原目的地等待。用户正在要求的直接发送、普通回复和明确任务交付继续执行。

## 新增 API

除 `/home` 静态页面、各自单独鉴权的 `/ingress/:accountId`、短时签名媒体链接外，以下接口都需要网关 Key。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/channels` | 读取/更新平台与目的地；凭据只用引用 |
| GET | `/api/ingress/status` | 原生接收器连接状态 |
| GET / POST | `/api/tasks` | 列出任务 / 提交后台目标 |
| GET | `/api/tasks/:id` | 进度、检查点与产物 |
| POST | `/api/tasks/:id/control` | pause / resume / cancel / handoff；交接另带 agentId、reason |
| GET | `/api/workspaces/:agentId` | 成员文件列表 |
| PUT | `/api/workspaces/:agentId/files?name=notes.md` | 直接上传二进制，Content-Type 指定 MIME |
| GET | `/api/files/:artifactId` | 鉴权下载真实字节 |
| POST | `/api/artifacts/:id/share` | 给 agentId 或当前 room 分享指定文件 |
| GET | `/api/inbox` | 当前房间所有者收件箱 |
| POST | `/api/inbox/:id/read` | 标为已读 |
| GET / POST | `/api/deliveries` | 回执 / 发到指定 destination，含 kind 与 artifactId 或 text |
| POST | `/api/deliveries/:id/retry` | 明确重试；unknown 需 confirmUnknown=true |
| GET / POST | `/api/notifications` | 通知规则 / 登记条件或时间 |
| POST | `/api/notifications/:id/disable` | 关闭通知 |
| POST | `/api/signals` | 用户授权的外部任务上报 name 与 data |

POST 聊天还接受 `attachments: [{"artifactId":"已上传文件 ID"}]`。当前输入文件授予本轮接话成员读取权，MCP 工具产生的媒体也会以真实文件 ID 返回给模型，便于后续跨端发送。

## 验收边界与来源

端到端协议测试覆盖 QQ 签名事件 → 聊天工具 → 真实 Markdown → Discord multipart，以及微信规范化入站 → 模拟语音服务返回真实 WAV → ffmpeg 转 Opus → TG sendVoice。Discord 原生 WebSocket 与 TG 长轮询也使用本地协议服务器验证。没有使用用户真实平台令牌，没有对真实 QQ/DC/TG/Weixin 账号发送测试消息；生产平台权限、文件大小、微信插件行为和真模型任务质量仍需账号联调。

手机页面已做 HTTP 接口与脚本解析检查；本环境没有浏览器二进制，未做真实手机视觉/触控验收。OpenClaw 规范化桥接与消息工具协议用本地响应验证，不冒充真实微信验收。

协议/实现参考，独立编写，未复制依赖项目源码：

- 安忒洛斯 `5ba3857...`：`src/discord/provider.ts` 与 `voice.ts`，区分文件附件与原生语音、转换并计算波形的交付流程。
- https://github.com/qimingjiu/anteros/tree/5ba3857da5682cf0d681ea8df3004ea4d2890ec4/src/discord
- https://docs.discord.com/developers/resources/message
- https://core.telegram.org/bots/api
- https://napneko.github.io/onebot/api
- https://docs.openclaw.ai/gateway/tools-invoke-http-api
- https://docs.openclaw.ai/channels/wechat

项目仍是 MIT，运行时没有新增第三方 npm 依赖；语音转换使用系统单独安装的 ffmpeg。
