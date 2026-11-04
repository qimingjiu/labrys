# MCP：从聊天到服务器安装

Labrys 在网关内执行 MCP 工具。安装是单独的后台任务，聊天只等待任务提交，不等待拉包和启动。只有完成协议检查、取得工具列表的服务会进入模型可用工具集。成员权限、房间权限和工具名单每次调用都会重新核验。

## 使用流程

1. 告诉当前成员要找什么工具，例如“找一个 GitHub MCP”。`mcp_search` 读取 Registry 元数据，结果缓存一小时。目录暂不可用时可以直接提供固定版本包名或远程地址。
2. 明确要求安装及范围，例如“安装这个 MCP，只给雾岛纪用”。模型调用 `mcp_install`，传结构化清单，立刻获得 `jobId`。
3. 如需密钥，打开网关地址下的 `/mcp?job=<任务 ID>`。输入网关 Key、填写所需凭据引用，然后提交重试。凭据不会经由这一步发送给回答模型。
4. 通过 `mcp_job_status` 查询结果。任务完成也会在原房间产生 `mcp.job.completed` 事件；尚未接真实平台主动通知适配器。
5. 让获准成员调用工具。换到另一个客户端仍使用网关内同一个服务与授权。

首次需要在服务器部署网关、配置模型和系统运行时。此后上述流程可在手机聊天和手机浏览器完成，不需要每次 SSH 或打开电脑。没有把这个代码包部署到用户的实际服务器。

## 模型工具

| 工具 | 行为 |
| --- | --- |
| `mcp_search` | 搜索 Registry，返回元数据与配置要求；不自动执行目录内容 |
| `mcp_install` | 固定版本安装或连接；已有同版本可用服务直接复用 |
| `mcp_job_status` | 查询后台任务、错误、脱敏日志；不带 ID 时列出当前成员可见服务 |
| `mcp_logs` | 最近 1–100 条可见服务日志；先做作用域检查 |
| `mcp_manage` | `start` / `stop` / `restart` / `update` / `uninstall` |

安装和管理操作只接受当前真实用户消息中的直接动作要求；工具参数中的 `userText`、`actorId`、`roomId` 等不能冒充授权。引用、否定、条件或教学表达不会启动部署。当前采用保守的本地句式匹配，复杂表达可改成直接指令或在管理页操作。聊天安装只授权当前房间；跨房间授权在管理页清单中明确配置。

工具注册名为 `mcp_<服务ID>_<原名哈希>`，保持稳定且避免同名覆盖。客户端不能占用 `mcp_` 命名空间。客户端自己的其他 function 工具仍交回客户端执行。

## 安装清单

远程 Streamable HTTP：

```json
{
  "id": "my-remote",
  "kind": "remote",
  "url": "https://your-mcp.example/mcp",
  "secretHeaders": { "Authorization": "remote-auth" },
  "allowedAgents": ["kirishima"],
  "allowedRooms": ["family"]
}
```

在凭据页面给 `remote-auth` 填完整请求头值，例如 `Bearer <token>`。不需要鉴权的服务可省略 `secretHeaders`。URL 中不能内嵌用户名、密码或 token 查询参数。

npm 服务（下面为占位包名，按真实包元数据填写）：

```json
{
  "id": "my-npm",
  "kind": "npm",
  "package": "@your-scope/your-mcp-server",
  "version": "1.2.3",
  "executable": "your-mcp-server",
  "args": [],
  "secretEnv": { "SERVICE_TOKEN": "service-token" },
  "allowedAgents": ["kirishima"],
  "allowedRooms": ["family"],
  "allowedTools": ["search", "read"]
}
```

`executable` 是包声明的 bin 名；只有一个 bin 时可省略。npm 使用 `--ignore-scripts`，需要 postinstall/native 编译的包会失败，需要另行提供已构建镜像。npm 入口按 Node 脚本启动；不支持任意 shell 启动命令。

Python 使用 `kind: "python"`、固定 `package` / `version`，再指定 `module` 或环境内的 `executable`。每个部署有独立 venv；系统需已有 Python 3、venv 和 pip。

Docker 使用 `kind: "docker"`、明确版本标签或 digest 的 `image`，可附 `args` / `env` / `secretEnv`。服务器需有 Docker 和拉取镜像权限。拉取后解析内容 ID，按内容 ID 启动。固定只读根目录、资源限制、移除 capabilities；不开放宿主目录挂载和 privileged 参数。私有仓库登录流程尚未集成。

所有清单均必须指定 `allowedAgents`、`allowedRooms`。`allowedTools` 可省略以使用全部公布工具，空数组表示不开放任何工具。普通非敏感配置用 `env`；凭据使用 `secretEnv` / `secretHeaders` 引用。

## 任务与更新

任务状态为 `queued` → `running` → `succeeded`，失败为 `failed`；缺少凭据为 `awaiting_input`，网关重启中断为 `interrupted`。每个服务只执行一个任务，全局串行部署、最多排队 16 个，避免拉包占满服务器。部署子命令默认五分钟超时；单次协议请求默认十五秒。MCP 工具调用不自动重试，以免重复有副作用的操作。

更新使用新目录先安装、启动并检查，通过后才替换连接；失败保留旧清单、旧版本和旧连接。成功更新的旧版本目录保留至卸载；当前未做历史版本清理和指定版本回滚 UI。restart 也先试新连接，单实例独占端口等服务可使用 stop 后 start。卸载只删除该服务部署目录和注册，不删除可能被其他服务使用的凭据。

已启用的服务在网关重启后从现有部署恢复，不重新拉包；恢复在后台进行。中断安装不会自动重跑。stdio 服务异常退出后工具下线，需要用户启动/重启；当前不做无限重连。

## 凭据、日志与网络

- SQLite 中的凭据用 AES-256-GCM 加密。默认在 MCP 数据目录生成权限 0600 的 `vault.key`；也可用 `MCP_SECRET_KEY` 配置 32 字节 hex/base64 密钥。数据库和密钥需要一起备份，重启时保持相同密钥。
- 部署/启动进程只继承最小运行环境，模型上游 Key 和网关 Key 不传入。凭据在连接时注入，不持久化到启动清单。
- 进程日志按完整行拼接后脱敏；超长行省略。每个服务最多保留 500 条，每条最多 2000 字符。工具结果中精确匹配的凭据也会在进入模型和事件记录前替换。
- 远程连接要求 HTTPS，拒绝跳转、内嵌凭据与默认私网访问。每次解析检查全部 IP 并固定实际连接 IP。`MCP_PRIVATE_HOSTS=127.0.0.1,localhost` 由服务器管理员明确授权私有/HTTP 主机，清单不能修改它。
- npm/Python 运行的是所选包的代码，拥有网关操作系统账户能访问的本地权限；专属目录和干净环境不等于完整文件沙箱。生产环境应使用专用账户，或选用受限 Docker 部署。
- 管理页不把 Key 放 URL 或 localStorage，使用同源 Bearer 请求与 CSP。通过公网使用时由反向代理提供 HTTPS。

## HTTP 管理接口

管理接口均需网关 Key；当前所有持有该 Key 的客户端都是家庭所有者。页面 `/mcp` 只提供静态界面，查询/变更仍要认证。

| 方法 | 路径 | 请求/结果 |
| --- | --- | --- |
| GET | `/api/mcp/services` | 注册服务、作用域与状态，不返回秘密值 |
| GET | `/api/mcp/search?query=...` | 目录搜索与缓存标记 |
| GET | `/api/mcp/secrets` | 只有凭据引用名 |
| POST | `/api/mcp/secrets` | `{ "ref": "service-token", "value": "..." }` |
| POST | `/api/mcp/install` | `{ "manifest": {...} }` → HTTP 202，任务 ID |
| POST | `/api/mcp/manage` | `{ "id": "my-mcp", "action": "stop" }`；update 另带 manifest |
| GET | `/api/mcp/jobs/:id` | 任务阶段、错误、脱敏日志、手机配置地址 |
| GET | `/api/mcp/services/:id/logs?limit=50` | 最近脱敏日志 |

图片/音频工具内容以响应顶层 `attachments` 扩展返回，每轮最多四个；SSE 放在最后的用量扩展帧中。模型上下文里保留附件说明，不塞 base64；客户端适配器需要实现附件展示。未实现 MCP prompts/resources/subscriptions、采样或 elicitation；服务请求不支持的客户端能力时收到协议错误。

## 验证范围

真实本地 npm 包安装、Python wheel/venv 安装与 stdio 调用已测。远程 HTTP 用本地协议服务器测鉴权、会话、分页、未关闭的 SSE 响应和 2026 请求元数据。Registry 搜索缓存使用本地目录响应测试，未承诺官方目录或任意第三方 MCP 随时可用。Docker 路径未做真实 daemon 验收；OAuth 浏览器回调、动态客户端注册、令牌刷新尚未实现，遇到 401/403 明确报告需要授权。

默认协商 2025-11-25 及兼容的既有握手版本；2026-07-28 的无初始化请求方式需要清单显式指定 `protocol`。不静默切换协议来重试有副作用的工具。

协议依据：

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/registry/about
