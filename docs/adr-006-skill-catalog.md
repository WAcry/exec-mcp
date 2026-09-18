# ADR-006：一次发现的 Skill 目录

状态：生效。日期：2026-09-18。

## 发现文档，不建设 Skill 平台

顶层仍只有 exec/wait；增加 exec 内的 list_skills，只返回名称、调用描述和全文位置。
首次使用实例或进入尚未发现的项目时，Agent 先显式输出这份目录，再按任务选择全文。
读取正文、参考资料和脚本继续用现有 Shell，不增加 Skill read/search/activate/run 或安装管理。
不把每个 Skill 伪装成 ALL_TOOLS 方法，不加入 UI、用户输入、子 Agent 或 stdio 入口。

服务启动不扫描、不注入全文，每次 list_skills 实时发现；不维护“模型已加载”标记、缓存或 watcher。
服务知道曾返回过目录，不代表压缩上下文后的模型仍记得它，因此不拦截重复发现。
exec 的说明负责提示先发现；这是模型行为指引，不通过检查调用顺序来锁住 Shell。

## 路径与范围

始终扫描运行服务账户的 ~/.agents/skills 和 ~/.codex/skills。
list_skills.workdir 优先；省略时只继承显式提供的 exec.workdir，否则只扫描用户目录。
相对路径与本机工具一致，以本次 exec 的默认目录解析。
项目范围从工作目录向上到最近的 .git 文件/目录，逐级扫描 .agents/skills，不向兄弟项目遍历；
没有 Git 边界时只扫描明确工作目录自己的 .agents/skills。

跟随目录和 SKILL.md 的软链接，使用真实目录避免循环，按真实 SKILL.md 路径去重；
同名但不同文件全部保留。真实路径用于打开全文和解析配套资源，路径压缩只能改变展示。
Skill 集合可分层，包括 .codex/skills/.system；发现一个 SKILL.md 后将其视为 bundle，
不继续进入它的脚本、依赖和参考资料寻找其他 Skill；忽略版本控制的内部目录。
不执行 Git、Skill 脚本或安装操作，不读取 Codex 的其他配置、数据库、插件或 enabled 列表。

## 显式调用的策略不能被压缩掉

解析 SKILL.md 的 YAML frontmatter，正文不返回；agents/openai.yaml 只读取调用策略。
allow_implicit_invocation=false 的 Skill 单独列为“仅用户明确要求使用”，仅保留名称和路径，
不泄漏触发描述，也不参与描述预算。任务相似、其他文档推荐或用户明确说“不使用”均不算授权。
缺少策略文件时沿用默认自动匹配；策略文件存在但无法读取/解析或字段非法时保守归为仅显式，附警告。
策略从真实 SKILL.md 所在的 bundle 读取，不让软链接的别名目录覆盖真实策略。
这不能强制阻止已有 Shell 读取文件，不将行为指引宣传成权限隔离。

## 40,000 字符的可调预算

默认目录目标为 40,000 个 Unicode 码点，作为约 10,000 tokens 的工程近似；不承诺精确 tokenizer 数量。
通过本服务 config.toml 的 [skills] max_chars 配置，不新增互相冲突的 token/字符双重旋钮。
计入标题、路径表、行格式、转义与警告，只对自动匹配项的 description 前缀做有损压缩。
名称、可还原路径和显式调用策略永不截短。先按目录分隔边界提取重复路径前缀，
只有包含别名说明和定义在内仍更短时才采用；描述空间逐字符 round robin 公平分配，
短描述完整后让出余量，截断用省略号标记。只返回一份目录文本，不同时附原始 JSON 镜像。

当最低完整目录本身超过目标时，保留所有名称/路径/策略并明确说明超预算；
不能为了硬塞进配置值而悄悄省略 Skill。这是软预算的唯一必要回退，不引入分页或按需搜索。
真正超过现有传输/资源边界则明确报错，不声称模型已收到完整目录。
Agent 输出目录时不应再设置过小的 exec.max_output_tokens；不为这个提醒新增另一套输出协议。

## 与 Codex 的复用边界

参考固定快照 7498521d288b9b3b96ffba4eedf089d8d6e06a84 的
[render.rs](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/render.rs) 和
[aliases.rs](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/aliases.rs)，
移植预算与路径别名算法的必要部分和行为测试，不声称调用原生 Skill Loader。
上游没有随当前固定包分发的独立 Skill Loader 二进制，渲染又属于扩展内部接口；
为这份目录另建跨平台 Rust 分发或接入 App Server 的代价超过收益。
我们有意区别于 Codex：显式调用项仍可见；极端小预算不省略条目；策略解析失败时不放开隐式调用。
来源和许可证保留在第三方说明中，测试覆盖这些差异，不追求整个 Codex Skill 配置的兼容实现。
