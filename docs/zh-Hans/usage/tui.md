---
title: "终端用户界面"
sidebarTitle: "TUI"
description: "启动 Monad 的终端客户端，并掌握驱动它所需的少量按键。"
keywords: ["Monad TUI", "终端界面", "键盘快捷键", "终端客户端"]
---
TUI 是键盘优先的客户端，适合想在终端里看实时对话的人。它连接的是同一个守护进程，因此会话、项目和审批与其他客户端完全一致。

这里能做的事都能用 `monad` 命令（见 [CLI 参考](/zh-Hans/usage/cli)）或浏览器（见 [Web UI](/usage/web)）完成。想看住并引导一段对话就用 TUI，要写脚本就用 CLI。

## 启动

```bash
monad tui
```

守护进程未运行时，TUI 会询问是否先启动它。空闲时连续按两次 `Ctrl+C` 退出。

## 使用

- 在输入框输入后按 `Enter` 发送；`Shift+Enter` 或 `Ctrl+J` 换行。
- 回复流式输出期间发送会进入队列；`Ctrl+Enter` 则是打断：停止当前回合，用你的文本开始新回合。
- 运行中按 `Ctrl+C` 停止当前回合，而不是退出。
- 输入 `/` 打开与 CLI、消息渠道相同的命令与 Skill 菜单。
- 审批以详情视图打开，批准与拒绝都需要再按一次 `Enter`，拒绝可附理由。

需要记住的按键：

| 按键 | 操作 |
|---|---|
| `Ctrl+K` | 命令面板——到达任意界面最快的方式 |
| ``Ctrl+` `` | Workspace 聊天 |
| `Ctrl+,` | 设置 |
| `Ctrl+P` | 计划面板 |
| `?` | 帮助 |
| `Esc` | 关闭或返回 |
| `Tab` / `Shift+Tab` | 移动焦点 |

布局会随终端宽度调整；窄于约 60 列时 TUI 会提示放大窗口。

## 它不做的事

TUI 渲染聊天、项目、Inbox 和设置。需要图表、可视化编辑器或浏览器流程的界面——Workplace Experience、第三方 Agent 交互式登录、Atom Pack 安装确认——会被标注出来，并可跳转到对应的 Web 路由。第三方 Agent 活动在这里是只读的：用 `monad mesh input` 或 Web UI 驱动运行时。
