---
title: "使用第三方 Agent"
sidebarTitle: "第三方 Agent"
description: "在持久 Monad 会话中运行服务商原生 Agent，并进行范围受限的监督。"
keywords: ["第三方 Agent", "Codex", "Claude Code", "Gemini CLI", "外部 Agent 运行时"]
---
第三方 Agent 是服务商原生 Agent 加入 Monad Mesh 的方式：它们作为团队成员在 Monad 会话中运行，由 Monad Mesh 监督进程、限定会话范围并把活动投射为连续时间线；服务商仍负责模型行为、认证、服务商会话身份和原生审批。

一个 mesh 可以完全由第三方 Agent 组成。Monad Agent Runtime 只是成员的第一方选项，而不是前提。

## 支持的服务商

| Provider ID | 产品 |
|---|---|
| `codex` | Codex |
| `claude-code` | Claude Code |
| `antigravity` | Antigravity |
| `gemini` | Gemini CLI |
| `qwen` | Qwen Code |
| `openclaw` | OpenClaw |
| `hermes` | Hermes |
| `monad` | Monad（把另一个 Monad 运行时当作 mesh 成员驱动） |

实际可用性由本机安装、配置、认证和适配器能力共同决定，不能只根据预设存在来判断。

## 检查已配置的 Agent

服务商自己的 CLI 必须先装在本机。从名册开始：

```bash
monad mesh agents          # 已配置的第三方 Agent、其服务商与状态
monad mesh auth codex      # 服务商侧的登录状态
```

**Monad 不代理登录。** 第三方 Agent 是拥有独立凭据的其他产品，请用它自己的 CLI 登录（`codex login`、`claude`……），Monad 会识别该会话。`monad mesh auth` 只报告状态；不提供探测能力的服务商报 `unknown`。

浏览器里 **Studio → Mesh agents** 显示同一份名册，也是唯一能在内嵌终端里跑交互式登录的界面。

## 使用已报告能力

每个适配器报告可用控制能力，例如输入、steer、interrupt、stop、approve、deny、resume 或 usage。启动后的 MeshSession 会保存实际生效能力；客户端必须根据该运行时能力显示操作，而不能根据服务商名称猜测。

```ts
type MeshRuntimeCapabilities = {
  input: boolean;
  steer: boolean;
  interrupt: boolean;
  approvals: boolean;
  usage: boolean;
};
```

提供方升级、启动参数和会话状态都可能改变能力，因此以活动运行时报告为准。

## 启动并观察 MeshSession

启动时绑定 Monad session、Agent 名称和工作路径。工作路径必须位于会话允许的项目根目录内。

```bash
monad mesh start codex --session ses_123 --cwd /workspace/project
monad mesh show <meshSessionId>
monad mesh watch <meshSessionId>
monad mesh input <meshSessionId> <text|->
monad mesh steer <meshSessionId> <text|->
monad mesh interrupt <meshSessionId>
monad mesh stop <meshSessionId>
monad mesh usage [meshSessionId]
```

Web UI 会把同一个运行时渲染成对话里的实时卡片，控制项相同；CLI 是可脚本化、也是唯一能无界面使用的路径。对应的 HTTP 接口（`POST /v1/mesh/sessions`、`/stream/convenience`、`/events/convenience`）契约见 [第三方 Agent 观察](/internals/agent-team-runtime/mesh-observation)。

观察接口提供两层数据：

- **raw observation**：服务商或原生 CLI 的可恢复原始事件页，是诊断和重放的权威来源。
- **convenience projection**：面向客户端的助手消息、工具、审批和状态投射。投射失败不应破坏原始事件读取。

流式观察先返回 `ready` 锚点，再以 cursor 发送 patch。重连时携带上次 cursor；cursor 缺失、过期或来自另一运行时时，客户端必须用新的 ready 状态替换本地 live 投射。

```json
{
  "kind": "ready",
  "cursor": "live:runtime-id:0",
  "events": []
}
```

提供方历史可能只覆盖 settled 结果，未必保留每个瞬时传输增量。`settled` 覆盖不能被描述为字节完整的 live replay。

## 输入、方向与审批

`input` 排队一个新回合；`steer` 在当前回合进行时加入新方向；`interrupt` 只停止当前工作；`stop` 终止运行时。只有活动能力支持时才能调用。

原生审批由服务商提出，Monad 可把请求转交给客户端：

```text
monad mesh approve <meshSessionId> <requestId>
monad mesh deny <meshSessionId> <requestId> --reason "not allowed"
```

无人回答时按配置关闭失败。服务商自有的 unattended 模式不会绕过 Monad 对运行时启动和宿主边界的限制。

## 常见故障

| 现象 | 含义 | 下一步 |
|---|---|---|
| `monad mesh agents` 里没有该 Agent | 尚未配置 | 在 Studio → Mesh agents 配置，或用 `monad import settings` 导入 |
| preset 显示 `installed: false` | 找不到服务商 CLI | 安装该 CLI 后重新检查 |
| `monad mesh auth <agent>` 报 `unauthenticated` | 凭据缺失或过期 | 用服务商自己的 CLI 登录 |
| `monad mesh start` 拒绝 `--cwd` | 路径超出项目根 | 选择根目录内路径 |
| 控制操作提示能力不支持 | 当前运行时不能执行 | 使用运行时报告的能力 |
| convenience history 为空 | 无可读事件源或投射 | 检查 raw observation 和适配器支持 |
| 流从 epoch 开头重放 | cursor 错误、过期或不属于该运行时 | 用新的 `ready` 锚点替换 live 状态 |
| raw page 标记 `settled` | 历史缺少瞬时增量 | 将其视为 settled 历史，而非完整 live capture |
