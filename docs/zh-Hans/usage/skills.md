---
title: "Skills"
sidebarTitle: "Skills"
description: "在 Monad 中安装、编写、发现并治理可移植的 Agent Skills。"
keywords: ["Agent Skills", "SKILL.md", "agentskills.io", "技能安装", "技能发现"]
---
Skill 是基于文件系统的可移植能力包，向 Agent 提供领域知识和操作流程，并只在需要时承担上下文 token 成本。Monad 使用 [agentskills.io](https://agentskills.io) 的 `SKILL.md` 格式。

## Skills 存放位置

守护进程从已安装 Atom Pack 和兼容的用户目录发现 Skills。常见布局：

```text
~/.monad/atoms/skills/<skill-name>/SKILL.md
<atom-pack>/skills/<skill-name>/SKILL.md
```

每个 Skill 是一个目录，以 `SKILL.md` 为入口。脚本、参考资料、示例、模板和资源都放在该目录内，并通过相对路径引用。文件名和目录名是包的一部分，移动后需要同步引用。

发现不等于启用。Skill 还会经过 frontmatter 校验、兼容性提示、eligibility gate、Agent 配置和激活规则。

## `SKILL.md` 格式

```markdown
---
name: release-audit
description: Audit a release when a user asks to verify artifacts and checksums.
allowed-tools: fs_read shell
---

# Release audit

Read the release manifest, verify every checksum, and report exact failures.
```

### Frontmatter 字段

| 字段 | 必需 | 含义 |
|---|---|---|
| `name` | 是 | 最多 64 字符，小写字母数字与单连字符；必须等于目录名，不能使用受保留品牌名 |
| `description` | 是 | 1–1024 字符，说明做什么以及何时使用；自动加载前模型只看到这里 |
| `license` | 否 | 许可证名称或包内文件 |
| `compatibility` | 否 | 最多 500 字符的环境要求；只给出警告，不阻止加载 |
| `metadata` | 否 | 任意字符串键值元数据 |
| `allowed-tools` | 否 | Skill 活动期间可自动批准的工具模式 |
| `disable-model-invocation` | 否 | `true` 时模型不能自动加载，只能由用户 `/name` 调用 |
| `user-invocable` | 否 | `false` 时不出现在 `/` 菜单，但模型仍可自动加载 |
| `requires` | 否 | 可执行文件、环境或配置等 eligibility gate |
| `paths` | 否 | 相对工作区的激活 glob |
| `context` | 否 | `fork` 时在隔离子 Agent 中执行 |
| `modelTier` | 否 | `fast`、`smart` 或 `power`；只用于 fork，由路由层选择具体模型 |

### Eligibility gates

`requires` 在 Skill 进入候选集前检查宿主条件。它用于表达真实依赖，不应用来隐藏权限要求。

```yaml
requires:
  bins: [git, bun]
  env: [RELEASE_TOKEN]
  config: [network.remoteAccess.enabled]
```

缺少要求时，Skill 不自动加载，并应向用户报告具体缺项。密钥只检查是否可用，不能读回或写进提示词。

### 激活路径

`paths` 让 Skill 只在工作区存在匹配文件时自动进入上下文：

```yaml
paths:
  - "packages/*/package.json"
  - "release/**/*"
```

Glob 相对当前工作区，不是 Skill 目录。路径激活只影响自动加载，用户显式调用仍会执行 eligibility 检查。

### Compatibility

`compatibility` 可声明 Monad 版本或环境预期：

```yaml
compatibility: ">=0.5.0; requires a POSIX shell"
```

版本不匹配会警告，但允许用户覆盖。它不是安全边界，也不能替代 `requires`。

## 模型如何使用 Skill

Monad 使用渐进式披露：

1. 发现阶段只把名称和 description 放入候选目录。
2. 模型或用户选择 Skill 后，才读取完整 `SKILL.md`。
3. 正文引用的脚本、参考资料和模板按需读取。
4. Skill 结束后，不会把整个包永久塞入每个后续回合。

因此 description 必须具体，不能只写“帮助处理任务”。它应包含用户意图和适用条件。

## 显式调用

在任意客户端输入 `/` 打开命令与 Skill 菜单。`/release-audit` 会显式调用同名 Skill；附加文字成为本次调用输入。`disable-model-invocation: true` 的 Skill 仍可这样使用。

`user-invocable: false` 适合只供模型根据上下文选择的内部流程。不要同时让 Skill 无法由模型和用户调用，否则它没有可达入口。

## 引用包内文件

正文使用 `${SKILL_DIR}` 引用 Skill 自身目录：

```markdown
Run `${SKILL_DIR}/scripts/verify.ts` and compare the result with
`${SKILL_DIR}/references/release-policy.md`.
```

解析后的路径必须留在 Skill 目录内。不要使用 `..` 穿越包边界，也不要假设当前工作目录就是 Skill 目录。

## 控制每个 Agent 的自动加载

Agent 配置可覆盖 Skills 的自动加载选择：

```jsonc
{
  "agent": {
    "agents": [
      {
        "id": "agent_release",
        "skills": {
          "release-audit": true,
          "browser-research": false
        }
      }
    ]
  }
}
```

这只控制候选与自动加载，不会授予 Skill 所需工具或绕过 eligibility、审批和沙箱。

## 管理 Skills

```sh
monad skill list
monad skill search <query>
monad skill install <source>
monad skill update <name>
monad skill remove <name>
monad skill enable <name>
monad skill disable <name>
monad skill new <name>
monad skill validate <path>
```

安装前检查来源、许可证、文件列表、脚本和 `allowed-tools`。更新等同于引入新第三方代码，需要重新审查。`validate` 检查格式与约束，但不证明流程安全或正确。

## 自行编写与程序记忆

`monad skill new my-skill` 从模板创建目录，随后运行：

```sh
monad skill validate ~/.monad/atoms/skills/my-skill
```

Agent 自己生成或修改的 Skill 被视为自编代码。它不能因此获得更低风险级别；宿主写入、shell、网络和 computer-use 仍遵循原有审批与沙箱规则。

把稳定、可重复、可验证的流程写入 Skill。一次性对话事实应进入会话或 Memory，而不是不断生成新的 Skills。

## 动态上下文

Skill 可以在加载时执行受控动态上下文入口，把当前状态生成成短文本。该机制必须 opt-in，输出有大小与时间限制，失败时应显式报告而不是注入半截结果。

动态上下文仍是不受信任输入：它不能包含密钥，不能绕过工具审批，也不能在后台持续运行。

## `allowed-tools`

`allowed-tools` 描述 Skill 活动期间可自动批准的工具模式：

```yaml
allowed-tools:
  - fs_read
  - "shell(git status*)"
```

规则应尽量窄，只包含完成流程确实需要的操作。它不扩大沙箱根目录、不绕过 SSRF 与大小限制，也不允许 host-control 获得全局持久批准。用户显式拒绝仍然优先。

## Fork 执行

`context: fork` 让 Skill 在隔离子 Agent 中运行，并把最终结果返回调用会话：

```yaml
context: fork
modelTier: smart
```

Fork 适合上下文量大、能独立完成且只需返回结果的工作。它不会创建新的 Monad 持久团队身份；执行仍继承调用方授予的能力边界，并应保留与源会话的因果关联。

### 能力层级

`modelTier` 表达相对能力和费用偏好：`fast` 用于简单提取，`smart` 用于一般复杂任务，`power` 用于最困难推理。它不固定服务商或模型 ID；路由层根据当前模型配置解析具体目标。

## 尚未支持的行为

- Skill 不能注册新的原生工具；工具是第一方守护进程能力。
- Skill 不能绕过 Atom manifest、工具 schema、审批或沙箱。
- Compatibility 不会硬性阻止执行。
- Fork 不等同于持久项目成员或任意分布式调度。
- 文件存在不代表自动信任、启用或预批准。

## 安全

把 Skill 当作可执行软件与提示词输入的组合：

- 安装前审查来源和所有文件。
- 限制 `allowed-tools`，不要批准宽泛 shell 或宿主控制模式。
- 不在正文、示例、argv 或动态上下文中放密钥。
- 使用 `${SKILL_DIR}` 并阻止目录穿越。
- 对下载、网络、文件写入和第三方命令保留现有运行时守卫。
- 更新后重新校验与审查，不能只依赖名称或旧版本信任。
