# dsh-project-progress

[![CI](https://github.com/zhangqijin890-bot/project-progress/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangqijin890-bot/project-progress/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zhangqijin890-bot/dsh-project-progress.svg)](https://www.npmjs.com/package/@zhangqijin890-bot/dsh-project-progress)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DeepSeek Harness（DSH）插件：**为每个项目自动创建进展记录、自动同步项目进展**，
当上下文满了开新会话时，新会话能快速了解项目进展、无缝接手。

## 演示

![dsh-project-progress 演示](assets/demo.gif)

## 它做什么

1. **自动创建项目**：你在某个工作区（项目目录）开始对话后，插件自动为这个工作区
   建立一份记录，存放在 `$DSH_HOME/projects/<项目名-路径哈希>/` 下。
   **一个工作区永远只对应一个项目目录**（按工作区路径归并，会话标题只作为展示信息）。
2. **自动同步进展**：每个回合（turn）结束时，自动把「用户请求 → 助手回复 → 用到的
   工具」写入结构化日志（`log.json`），并重新生成人类可读的 `progress.md`；
   若配置了 LLM 摘要（默认开启），还会按去抖间隔自动生成「当前状态」摘要（`digest.txt`）。
3. **为已有会话补建**：插件安装前的历史会话也能生成项目文件——
   - **启动时自动**：dsh web 重启后，自动为当前活跃会话补建进展记录；
   - **手动全量**：`/project backfill` 扫描所有持久化会话（含早已结束的历史会话），
     为它们补建项目文件。补建是幂等的，重复执行不会产生重复记录。
4. **新会话快速接手**：
   - **自动注入**：在新会话的第一个回合，自动把项目进展摘要作为上下文注入
     （可配置关闭，`autoInject: false`）；
   - **工具**：模型可随时调用 `get_project_progress` 读取进展、`update_project_progress`
     留下交接笔记；
   - **命令**：输入 `/project` 查看进展，`/project sync` 立即刷新摘要，
     `/project path` 输出进展文件路径，`/project backfill` 为历史会话补建，
     `/project merge` 把旧版本按会话标题拆分的同工作区目录合并成一个。

## 目录结构

```
$DSH_HOME/projects/<project-key>/
├── project.json   # 元数据：标题、路径、会话列表、统计
├── log.json       # 结构化回合日志（有界，默认最多 200 条）
├── notes.json     # 交接笔记（模型通过 update_project_progress 写入）
├── digest.txt     # 最新 LLM 摘要
└── progress.md    # 人类可读进展文档（由上面几项生成）
```

> project-key 由**工作区路径**生成（目录名哈希 + 工作区名），因此无论会话标题怎么变，
> 同一工作区的进展永远落在同一个目录；`/project merge` 可把旧版本遗留的
> 同工作区多目录合并（插件启动时也会自动迁移合并）。

## 安装

## 安装

### 标准方式（推荐，需要 pnpm）

在 profile 目录（例如 `~/.dsh/profiles/web`）安装本插件：

```sh
dsh plugin --profile web add @zhangqijin890-bot/dsh-project-progress
# 等价于在 ~/.dsh/profiles/web 下执行：pnpm add @zhangqijin890-bot/dsh-project-progress
```

> 注意：如果 profile 的 `pnpm-workspace.yaml` 里 `autoInstallPeers: false`（DSH 默认），
> 需要把 `peerDependencies` 里列出的 `@deepseek-ai/*` 包一并安装，否则插件运行时
> 无法解析依赖。用 `dsh plugin` 安装时会按 pnpm 规则处理。

### 无 pnpm 时的符号链接方式

1. 把插件链接进 profile 的 node_modules：

   ```sh
   ln -sfn <本插件源码路径> ~/.dsh/profiles/web/node_modules/@zhangqijin890-bot/dsh-project-progress
   ```

2. 让插件源码旁的 node_modules 能解析 `@deepseek-ai/*` 依赖：
   在源码目录旁建一个 `node_modules/@deepseek-ai/`，把 `cordis`、`dsh-llm`、
   `dsh-session`、`dsh-tools`、`schemastery` 等链接到 DSH 安装目录下的同名包。

3. 注册 patch（见下）。

### 注册 patch

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在数组里追加（可参考
`cordis.patch.example.yml`）：

```yaml
- insert:
    - id: project-progress
      name: '@zhangqijin890-bot/dsh-project-progress'
      config:
        autoInject: true
        llmDigest: true
        digestMinIntervalMs: 60000
```

最后**重启 dsh web**（服务端插件在启动时加载，改代码后也需重启）：

```sh
dsh web
```

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `projectsDir` | `$DSH_HOME/projects` | 项目存储根目录 |
| `maxLogEntries` | `200` | 回合日志保留条数上限 |
| `maxRecentActivity` | `10` | progress.md「最近活动」展示条数 |
| `turnTextMaxChars` | `300` | 单条请求/回复截断长度（字符） |
| `maxInjectChars` | `4000` | 新会话自动注入摘要的最大字符数；`0` 关闭注入 |
| `autoInject` | `true` | 是否在新会话首回合自动注入进展摘要 |
| `llmDigest` | `true` | 是否用 LLM 生成「当前状态」摘要（失败自动回退规则摘要） |
| `digestMinIntervalMs` | `60000` | 两次 LLM 摘要最小间隔 |
| `digestMaxInputChars` | `20000` | 摘要输入上限 |
| `maxDigestTokens` | `512` | 摘要输出 token 上限 |
| `digestTimeoutMs` | `30000` | 摘要调用超时 |
| `provider` / `model` | 无 | 摘要所用模型路由；缺省时使用会话自身的模型 |

## 使用

- 正常对话即可，进展自动记录。
- 在任意会话输入 `/project` 查看当前项目进展；`/project sync` 强制刷新摘要。
- **历史会话补建**：`/project backfill` 为所有已存在的会话（含插件安装前的）补建
  项目文件；dsh web 启动时也会自动为活跃会话补建。
- **目录合并**：升级到按工作区归并的版本后，启动会自动把旧版本拆分的同工作区目录
  合并成一个；也可以手动执行 `/project merge`。
- 模型在需要时自动调用 `get_project_progress` / `update_project_progress`。
- 上下文满了：在同一个项目目录开新会话，插件会自动注入进展摘要，新会话直接续上。

## 卸载

```sh
# 从 cordis.patch.yml 删除 project-progress 那一行 insert
dsh plugin --profile web remove @zhangqijin890-bot/dsh-project-progress
# 如需删除历史记录：rm -rf $DSH_HOME/projects
```

## 说明

- 插件只在会话 `cwd` 可解析时记录；无工作区的会话会被跳过。
- 所有事件处理都做了错误隔离，插件出错不会影响会话主流程。
- 进展文件写入按项目串行化，避免并发写坏 `progress.md`。
