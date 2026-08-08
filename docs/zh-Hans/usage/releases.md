---
title: "发行版与升级"
sidebarTitle: "发行与升级"
description: "选择 Monad 发行通道，安全升级或回滚，并理解客户端与守护进程兼容性。"
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

安装时选择 beta：

```bash
curl -fsSL https://release.monadix.ai/monad/install.sh | bash -s -- --channel beta
```

没有 `curl` 时，可运行 `wget -qO- https://release.monadix.ai/monad/install.sh | bash -s -- --channel beta`。

已有安装可切换通道：

```bash
monad upgrade --channel beta
```

## 升级与回滚

```bash
monad upgrade --check
monad upgrade
monad upgrade --changelog
monad upgrade rollback
monad upgrade --prune-backups
```

`--check` 只报告，不修改文件。正常升级会校验下载并保留上一二进制；`rollback` 恢复上一次版本；`--prune-backups` 只保留最近三个备份。

## 版本与兼容性

CLI 与守护进程在连接时交换版本。兼容版本正常连接；不兼容时客户端会拒绝继续并给出升级方向。远程连接可以用 `--force` 绕过版本拒绝，但这只适合诊断，不代表协议兼容。

运行 `monad` 时，若已安装客户端要求更高守护进程版本，启动流程可以更新本地守护进程。显式 `monad upgrade` 才会主动检查所选发行通道；没有后台更新轮询。

## 支持范围

稳定版是面向普通用户的受支持线路。Beta 用于提前验证下一稳定版，nightly 只保证对应 `main` 提交的构建结果，不承诺跨日期兼容。提交问题时同时提供 `monad version`、`monad status` 和所用通道。

## 校验下载

发行资产附带 SHA256 文件。安装器会自动校验；手动安装时必须在执行二进制前比对校验和。详细步骤见[安装或移除 Monad](/zh-Hans/usage/installation)。
