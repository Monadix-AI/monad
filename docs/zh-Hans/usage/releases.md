---
title: "发行版与升级"
sidebarTitle: "发行与升级"
description: "选择 Monad 发行通道，安全升级，并理解客户端与守护进程兼容性。"
keywords: ["Monad 升级", "stable", "beta", "nightly", "版本兼容"]
---
Monad 把守护进程、CLI 和 Web 界面作为同一个带版本号的构建一起发布，分三条通道：默认的 `stable`、预发布的 `beta`，以及跟随 `main` 最新提交的 `nightly`。

本指南说明应该运行哪个构建、如何切换发行通道，以及可以依赖的兼容性边界。

## 发行通道

| 通道 | 适用人群 | 节奏 | 版本格式 |
|---|---|---|---|
| `stable`（默认） | 所有用户 | 经人工审查的 release PR 从 `main` 发布 | `v0.2.0` |
| `beta` | 愿意反馈问题的早期用户 | 使用同一质量门的预发行版本 | `v0.2.0-beta.1` |
| `nightly` | 跟踪 `main` 的开发者 | 自动构建当天 `main` 最新提交 | `v0.2.0-nightly.<date>+<sha>` |

每个 dist 安装器都绑定到一个精确发行 tag。先用 latest 安装稳定版，需要时再显式切换已有安装：

```bash
monad upgrade --channel beta
```

## 升级

```bash
monad upgrade --check
monad upgrade
monad upgrade --notes
monad upgrade --tag v0.1.3    # 安装指定版本，也可用于降级
monad upgrade --force         # 强制重装当前选择的版本
monad doctor update           # 检查更新器、receipt、通道和上次升级日志
```

`--check` 只报告，不修改文件。CLI 会把所选 channel 解析为精确 GitHub release tag，再交给 `monad-update`。Web UI 跟随当前构建的 channel，先退出守护进程，更新成功后再重启。

`--tag` 与 `--channel` 不能同时使用。指定 tag 属于明确操作，因此允许降级；`--force`
只跳过“版本相同”判断，下载和校验流程保持不变。

## 版本与兼容性

CLI 与守护进程在连接时交换版本。兼容版本正常连接；不兼容时客户端会拒绝继续并给出升级方向。远程连接可以用 `--force` 绕过版本拒绝，但这只适合诊断，不代表协议兼容。

运行 `monad` 时，若已安装客户端要求更高守护进程版本，启动流程可以更新本地守护进程。显式 `monad upgrade` 才会主动检查所选发行通道；没有后台更新轮询。

## 支持范围

稳定版是面向普通用户的受支持线路。Beta 用于提前验证下一稳定版，nightly 只保证对应 `main` 提交的构建结果，不承诺跨日期兼容。提交问题时同时提供 `monad version`、`monad status` 和所用通道。

## 校验下载

发行资产附带 SHA256 文件。安装器会自动校验；手动安装时必须在执行二进制前比对校验和。详细步骤见[安装或移除 Monad](/zh-Hans/usage/installation)。
