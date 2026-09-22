# ADR-006：一次发现的 Skill 目录

状态：生效。更新：2026-09-22。

## 发现文档，不建设 Skill 平台

tools.list_skills 在 exec 内调用，只返回名称、调用描述和全文位置。
目录让 Agent 知道可用工作流程，再按任务选择全文；不以工具描述强制固定的调用顺序。
读取正文、参考资料和脚本继续用现有 Shell，不增加 Skill read/search/activate/run 或安装管理。
不把每个 Skill 伪装成 ALL_TOOLS 方法，不引入独立执行平台。Web 可查看目录和开关已有配置，但不代替模型选择。

服务启动不扫描、不注入全文，每次 list_skills 实时发现；不维护“模型已加载”标记、缓存或 watcher。
服务知道曾返回过目录，不代表压缩上下文后的模型仍记得它，因此不拦截重复发现。
契约说明目录和全文的区别；不通过检查调用顺序来锁住 Shell。

## 路径与范围

始终扫描运行服务账户的 ~/.agents/skills 和 ~/.codex/skills。
list_skills.workdir 优先；省略时只继承显式提供的 exec.workdir，否则只扫描用户目录。
相对路径基于本次 exec.workdir。
项目范围从工作目录向上到最近的 .git 文件/目录，逐级扫描 .agents/skills，不向兄弟项目遍历；
没有 Git 边界时只扫描明确工作目录自己的 .agents/skills。

跟随目录和 SKILL.md 的软链接，使用真实目录避免循环，按真实 SKILL.md 路径去重；
同名但不同文件全部保留。真实路径用于打开全文和解析配套资源，路径压缩只能改变展示。
Skill 集合可分层，包括 .codex/skills/.system；发现一个 SKILL.md 后将其视为 bundle，
不继续进入它的脚本、依赖和参考资料寻找其他 Skill；忽略版本控制的内部目录。
不执行 Git、Skill 脚本或安装操作，不读取 Codex 的其他配置、数据库、插件或 enabled 列表。

## 实例配置中的启停

由操作者在本服务的 config.toml 中设置 Codex 风格的 skills.config 数组；未匹配规则默认启用。
选择器与顺序语义参考 [Codex 0.155.1 的 SkillConfigRules](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/config/src/skills_config.rs)，不加载其配置层。
每项用 name 或 path 二选一，加显式 enabled 布尔值；名称精确匹配所有同名项，路径只匹配指定的 SKILL.md，
按配置顺序应用，最后匹配者生效。采用路径选择器而不是只按名称去重，才能为同名 Skill 单独启用或禁用。
相对路径基于配置文件，支持 ~/；每次发现时解析软链接，与目录中的真实文件身份一致，不缓存旧链接目标。

禁用在呈现、描述预算和调用策略处理之前生效，不返回禁用项的元数据或状态清单；
配置与工具协议分离，不增加模型管理工具或工具描述中的启停教程。用法放[配置指南](configuration.md#skills)。
enabled=true 不改变 allow_implicit_invocation=false，也不增加搜索根目录或验证/执行 Skill 正文。
缺失的配置目标可以以后出现，不要求配置时文件必须存在；修改配置仍需重启服务，不引入热更新或 watcher。
该开关只管理目录可见性，不是文件访问权限，也不会撤回模型先前已经收到的内容。

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

目录还适配最终模型出口的字节目标，优先压缩描述，减少外层首尾裁剪隐藏中间 Skill 的风险。
当最低完整目录本身超过目标时，渲染器保留所有名称/路径/策略并明确说明超预算；
不能为了硬塞进配置值而悄悄省略 Skill。这是软预算的唯一必要回退，不引入分页或按需搜索。
外层仍执行全响应预算；最低目录过大时可能裁剪，真正超过传输边界则报错，不声称模型已收到无限完整目录。
路径别名与描述省略的解释随实际压缩后的目录返回；工具说明只保留发现用途、目录范围和全文读取方法，
不提前注入压缩算法、配置预算或极端预算回退的教程。

## 与 Codex 的复用边界

参考固定快照 7498521d288b9b3b96ffba4eedf089d8d6e06a84 的
[render.rs](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/render.rs) 和
[aliases.rs](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/aliases.rs)，
移植预算与路径别名算法的必要部分和行为测试，不声称调用原生 Skill Loader。
上游没有随当前固定包分发的独立 Skill Loader 二进制，渲染又属于扩展内部接口；
为这份目录另建跨平台 Rust 分发或接入 App Server 的代价超过收益。
我们有意区别于 Codex：显式调用项仍可见；极端小预算不省略条目；策略解析失败时不放开隐式调用。
来源和许可证保留在第三方说明中，测试覆盖这些差异，不追求整个 Codex Skill 配置的兼容实现。
