---
title: "从另一台设备访问 Monad"
sidebarTitle: "远程访问"
description: "有意识地开启 Monad 远程访问：TLS、bearer 认证，以及受控的网络边界。"
keywords: ["Monad 远程访问", "TLS", "bearer token", "Tailscale", "守护进程安全"]
---
Monad 默认只绑定回环地址。除非确实有另一台设备需要访问守护进程，否则保持这个默认值。

## 开启之前

- 把守护进程 API 当作控制面，不是公开的 Web API。
- 优先使用私有网络（例如你自己拥有的 tailnet），而不是直接暴露到公网。
- 把远程 bearer token 当作凭据来保护。
- 复核守护进程能触达的工具、沙箱、渠道和 Agent 运行时。
- 保持开发者模式关闭；本地 Scalar 包含内部路由，不得对外代理。

## 开启方式

远程访问是唯一在浏览器里完成的配置流程：**设置 → 连接**。打开它时，守护进程会自己生成 bearer token、在同一次写入中启用 TLS，并把 token 展示一次供你复制。使用明文 HTTP 的远程访问需要额外的显式确认。

这里刻意没有提供 `monad config set network.remoteAccess.token …`：作为命令行参数传入的密钥，本机任何用户都能通过 `ps` 读到，还会留在 shell 历史里。手动在 `config.json` 里翻转 `network.remoteAccess.enabled` 同样会让 token 为空，所以请使用连接设置页。

其余环节都归 CLI：

```bash
monad status                 # 实际使用的监听器、协议和地址
monad remote tls show        # 证书指纹与有效期
monad remote tls renew       # 重新签发守护进程证书
monad remote tls trust       # 把它加入本机信任库
monad restart                # 应用监听器变更
```

随后客户端按次指定要连接的守护进程，并从文件而不是 argv 读取 token：

```bash
monad status --host monad.example.com --token-file ~/.monad/remote-token
```

## 运行时保护

启用远程访问后，非回环的 TCP 请求需要提供配置好的 bearer token。守护进程在比对 token 之前先做按 IP 的限流，并把浏览器来源校验与 bearer 认证分开处理。本地 Unix socket 和回环客户端保留原有的本地信任行为。

TLS 配置和证书状态属于守护进程的网络设置。在连接另一台设备之前，先从可信的本地客户端确认监听器、协议、证书指纹和有效期。

## 验证清单

1. 在本地运行 `monad status`，确认监听器符合预期。
2. 确认你不打算暴露的接口上远程访问处于关闭状态。
3. 从第二台设备经私有网络、使用 bearer token 连接。
4. 验证未认证的远程请求会被拒绝。
5. 验证目标客户端能读取健康状态，并且只能执行它应有的流程。
6. 复核日志，不要把凭据抄进缺陷报告。

具体配置字段和传输行为，见[运行时、传输、配置与安全](/internals/infra/runtime)（英文）。
