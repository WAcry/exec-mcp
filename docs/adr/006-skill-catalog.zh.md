# ADR-006 一次发现的 Skill 目录

[English](006-skill-catalog.md) | 简体中文

当前生效，2026-09-22 更新。

## 目录与全文

tools.list_skills 在 exec 内返回 Skill 名称、用途和全文路径，Agent 据此选择需要读取的工作流程。
正文、参考资料和脚本通过现有 Shell 使用，不另设 Skill read/search/activate/run 或安装工具。
ALL_TOOLS 只列可调用方法，Skill 保持文档形式。Web 可以查看目录和开关配置，选择仍由模型作出。

每次 list_skills 实时发现，启动时不扫描或注入全文。目录返回后，模型也可能因上下文压缩忘记内容，
因此允许重复发现，不维护“已加载”标记、目录缓存或 watcher。调用顺序由 Agent 按任务安排。

## 路径与范围

始终扫描服务账户的 ~/.agents/skills 和 ~/.codex/skills。list_skills.workdir 优先，
省略时只继承显式提供的 exec.workdir；两者都没有时，仅扫描用户目录。相对路径基于本次 exec.workdir。
项目发现从工作目录向上到最近的 .git 文件或目录，逐级查找 .agents/skills，范围不包括兄弟项目。
没有 Git 边界时，只检查指定目录自己的 .agents/skills。

目录和 SKILL.md 的软链接均解析到真实文件，按真实路径去重并避免循环。
同名但不同文件保留，真实路径也用于打开全文和定位配套资源；路径压缩只改变显示方式。
Skill 集合可分层，包括 .codex/skills/.system。发现 SKILL.md 后按一个 bundle 处理，
不再进入其脚本、依赖和参考资料寻找其他 Skill，版本控制内部目录也跳过。
发现过程只读文件，不运行 Git、Skill 脚本或安装操作；Codex 的其他配置、数据库和插件保持独立。

## 配置启停

操作者在 exec-mcp 的 config.toml 中设置 skills.config，未匹配规则的 Skill 默认启用。
选择器与顺序语义参考 [Codex 0.155.1 SkillConfigRules](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/config/src/skills_config.rs)，
配置仍只从本服务读取。每项使用 name 或 path，并提供 enabled 布尔值。
name 精确匹配所有同名项，path 指定一个 SKILL.md，因而可单独控制同名的不同文件。
按配置顺序应用，最后匹配者生效。

相对路径基于配置文件，支持 ~/。每次发现重新解析软链接，避免旧链接目标影响当前文件身份。
禁用项不参与展示、描述预算或调用策略处理，目录也不返回其状态。
模型工具中不增加启停教程，用法见[配置指南](../guides/configuration.zh.md#skills)。

enabled=true 只启用既有发现范围中的文件，allow_implicit_invocation=false 仍然生效。
配置路径可以暂不存在，之后发现时再匹配；配置更新需要重启，没有热更新或 watcher。
开关只改变目录可见性，Shell 文件权限和模型已经收到的内容保持不变。

## 显式调用策略

SKILL.md 读取 YAML frontmatter，agents/openai.yaml 读取调用策略，发现结果不包含全文。
allow_implicit_invocation=false 的项目单独列为仅显式调用，只保留名称和路径，
触发描述不显示，也不参与描述预算。这类 Skill 只有用户明确要求才可使用，
任务相似、其他文档推荐或用户说不使用都不算授权。

缺少策略文件时默认允许按任务匹配；策略存在但无法读取、解析或字段非法时，归为仅显式并附警告。
策略从真实 SKILL.md 所在 bundle 读取，软链接别名目录不覆盖它。
这是模型的调用规则，Shell 仍按系统权限读取文件。

## 目录预算

默认目标为 40,000 个 Unicode 码点，约 10,000 tokens，具体 token 数取决于模型。
用户通过 [skills] max_chars 调整，不另设 token 开关。预算包含标题、路径表、行格式、转义和警告，
只允许缩短自动匹配项的 description 前缀，保留完整名称、可还原路径及显式调用策略。

先提取目录边界上的公共路径前缀，只有算上别名定义和说明后仍更短才采用。
剩余描述空间逐字符 round robin 分配，短描述完整后让出余量，截断以省略号标记。
只返回一份目录文本，不再附原始 JSON 镜像。

目录同时适应最终模型响应的字节预算，优先缩短描述，减少外层首尾裁剪省略中间 Skill 的情况。
若名称、路径和策略本身已超过目标，渲染器仍保留所有条目并说明超预算，不分页或隐藏 Skill。
外层响应限制继续生效，过大的最低目录仍可能被裁剪，超过传输限制则报错。
因此渲染器保留完整目录与模型能收到多少内容分别检查。

路径别名和省略规则随实际压缩结果说明。工具描述只写用途、范围和读取全文的方法，
无需提前讲解预算算法或极端情况。

## Codex 复用范围

参考固定快照 7498521d288b9b3b96ffba4eedf089d8d6e06a84 的
[render.rs](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/render.rs) 和
[aliases.rs](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/aliases.rs)，
移植必要的预算和路径别名算法及其测试。固定包没有独立 Skill Loader 二进制，
渲染接口也属于上游扩展内部；直接移植这部分比另做 Rust 分发或接入 App Server 更省维护。

本项目保留显式调用项的名称与路径，小预算下也不主动删条目。策略解析失败时继续要求显式调用。
这些差异由测试覆盖，移植部分的来源见上述链接及源码注释，许可见 [Apache-2.0](../../proto/LICENSE)。
其余 Codex Skill 配置不在兼容范围内。
