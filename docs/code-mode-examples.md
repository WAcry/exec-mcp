# Code Mode 用法示例

以下片段是 `exec.source` 中的 JavaScript；Shell 代码放在 `tools.exec_command({cmd})` 中。
调用发生在 exec-mcp 的实际机器，与其他独立容器的文件、进程和网络不共享。
示例供按需参考，完整参数和返回契约以工具描述为准。

## 输出先在代码里筛选

最终返回模型的文本合计最多 36,000 UTF-8 字节，按目标宿主的输出容量设置，token 数仍取决于模型。
嵌套工具先返回原值，脚本再选择要用 text 展示的部分。

```js
const result = await tools.exec_command({ cmd: "git status --short" });
text(result);
```

较大的日志可以先保存，再查找错误并输出摘要。

```js
const result = await tools.exec_command({ cmd: "your-build-command" });
store("build-result", result);
text({
  exit_code: result.exit_code,
  session_id: result.session_id,
  truncated: result.truncated ?? false,
  stderr_bytes: result.stderr_bytes,
  matches: result.output.split(/\r?\n/).filter(line => /error|failed|exception/i.test(line)).slice(0, 40),
  tail: result.output.slice(-4000)
});
```

后续可从 `load("build-result")` 分段取内容。store 按当前 ChatGPT 对话关联，保存在临时内存中。
上限保护只保留最终文本首尾，被省略内容不会由 wait 自动补发；在结束前保存需要复用的数据。
终端每次最多交回 4 MiB，未读内容用同一 session_id 的 write_stdin 续取；每个进程默认缓冲 16 MiB。
超过缓冲后中间日志会丢弃并返回 truncated/omitted_bytes，因此没有搜到错误不能证明全过程无错误。
确需完整原始日志时由调用方显式重定向文件；服务不替所有工具自动落盘。

## 终端收集窗口与外层等待

`tools.write_stdin` 省略 `chars` 或传空字符串时只收集未读输出，默认 5 秒；非空输入默认 250 毫秒。
两者都在进程结束或窗口到期时返回，已有和新增日志不提前结束窗口。有效范围分别为 5000 至 300000、250 至 30000 毫秒，
另保留显式 `0` 立即读取。超时不终止进程；返回 session_id 时后续继续使用该句柄。

长任务可以在一个 exec 中等待更久，返回结果前再筛选内容。

```js
const result = await tools.write_stdin({ session_id: "之前的句柄", yield_time_ms: 300000 });
text(result);
```

exec 本身仍可能先交回 `cell_id`，此后由外层 `wait` 续取。内层终端收集窗口不受外层 110 秒窗口截断，
外层 wait 超时也不重启或重放内层调用。不要重新执行原命令来续取结果。
等待不扩大日志或模型输出预算；已退出但剩余输出超过单次读取上限时，同样需要继续读取。

## 判断脚本与命令结果

`Script completed` 只表示 JavaScript 已结束；嵌套命令仍可能返回 `exit_code: 1`。
`exit_code` 是 Shell 退出码，管道的 `stderr_bytes` 表示累计收到的错误流字节（包括可能已滚动移除的内容），
错误流也可能只是进度或警告；PTY 本身合并流，没有独立错误流计数。

下面的 PowerShell 命令会先输出错误，再输出成功文字。

```js
text(await tools.exec_command({
  cmd: "Write-Error 'expected diagnostic'; Write-Output 'later success'"
}));
```

这里可能返回 `exit_code: 0`，错误文本和 stderr_bytes 仍然存在。
需要遇到 PowerShell 错误即停止时，可以显式设置错误策略。

```js
text(await tools.exec_command({
  cmd: "$ErrorActionPreference='Stop'; Write-Error 'stop here'; Write-Output 'should-not-run'"
}));
```

服务不擅自修改错误策略。原生程序的退出码可用 `exit $LASTEXITCODE` 显式传回。

## 在 exec 中查阅下游工具

`ALL_TOOLS` 是 `{name, description}[]`；description 包含完整的输入、返回契约，工具名称与 `tools` 上的绑定一致。
可按名称或描述筛选后输出，也可只列名称缩小范围。

```js
text(ALL_TOOLS.filter(t => /github|pull_request/i.test(t.name + " " + t.description)));
```

阅读命中项后使用它的准确名称调用 `await tools[name](args)`；已知名称和参数可以直接调用。
这是当前 exec 的已绑定快照，筛选本身不连接或执行下游，也不自动把完整目录加入模型上下文。

## MCP 资源

资源是下游服务提供的数据，如文档原文、数据库结构或参数化上下文；ALL_TOOLS 则列出可调用方法。
三个资源辅助方法在 exec 内使用。已知 URI 可以直接读取，需要查目录时可先列出资源。

```js
const result = await tools.list_mcp_resources({});
text(result);
```

每条目录带 `server`。以下以已配置的 `docs` 服务为例，指定服务只取一页；
续页时把 `nextCursor` 原样传回同一个服务、同一种列表。

```js
const page = await tools.list_mcp_resources({ server: "docs" });
text(page);
```

用列表或工具返回的 URI 读取资源，返回条目在 `contents` 字段中。
MCP 工具结果使用的 `content` 是另一个字段，读取时按各自结构处理。

```js
const result = await tools.read_mcp_resource({
  server: "docs",
  uri: "memo://project/readme"
});
for (const item of result.contents) {
  if (item.text !== undefined) text(item.text);
}
```

`list_mcp_resource_templates({ server: "docs" })` 返回 `uriTemplate`；按其参数展开出具体 URI 后，
仍用 `read_mcp_resource`。一个服务即使资源列表为空，也可能提供模板或只在工具结果中返回资源链接。
资源 URI 交给指定下游，不作为本机路径或任意网络地址读取。二进制条目的 `blob` 是 Base64，
例如已知为图片时可用 `image("data:" + item.mimeType + ";base64," + item.blob)` 显式输出。
大资源可先用 JS 筛选或 store；沿用嵌套结果传输上限与最终模型输出预算，不自动落盘。

## 在 exec 内构造含 Markdown 的多行补丁

`tools.apply_patch(patch)` 接收完整补丁字符串，服务经 stdin 将它传给补丁引擎。
无论使用哪种 JavaScript 字符串写法，这条调用都不经过 Shell，无需再包一层 heredoc。

```text
JS source → patch string → tools.apply_patch(patch) → stdin → patch engine
```

普通引号字符串、模板字面量和 `String.raw` 都能构造补丁。调用者根据正文选择，文件类型和补丁大小不限定写法。

| 构造方式 | 需要留意的语法 |
| --- | --- |
| 普通引号字符串，可逐行组成数组后 `.join("\n")` | 反引号和 `${...}` 是普通文本；作为分隔符的引号与反斜杠仍按 JS 转义规则处理。 |
| 模板字面量 | 可以直接换行；正文中的反引号、`${...}` 与反斜杠有 JS 语义，写入的缩进也会保留。 |
| `String.raw` 模板 | 保留模板片段中的反斜杠，仍解析反引号和插值；为它们加的转义反斜杠也可能进入补丁。 |

下面用逐行数组展示一份含 Markdown 围栏的补丁。数组在 JS 内拼成字符串后传给工具。

```js
const patch = [
  "*** Begin Patch",
  "*** Add File: patch-example.md",
  "+# Review notes",
  "+Use `review` mode.",
  "+```console",
  "+uv run demo.py",
  "+```",
  "+Literal placeholder: ${name}",
  "+Windows path: C:\\work\\new\\file.txt",
  "+Regex: Sig\\[\\d+\\]",
  "+Literal escape: \\uXXXX",
  "+Quotes: \"double\" and 'single'.",
  "+\tTabbed",
  "+    indented",
  "+",
  "*** End Patch",
  "",
].join("\n");
text(await tools.apply_patch(patch));
```

`.join("\n")` 在各项之间加入真实 LF；`.join("\\n")` 会插入字面量反斜杠和 n。
普通模板也可直接表达多行正文。

```js
const patch = `*** Begin Patch
*** Add File: template-example.md
+# Notes
+Keep the existing interface.
*** End Patch
`;
text(await tools.apply_patch(patch));
```

这些方式同样适用于更新文件或在一个补丁中修改多个文件。补丁使用真实换行，以 `*** Begin Patch` 开始，
标记顶格；新增行的 `+` 后保留文件实际缩进、Tab 和行尾空白。

已有补丁字符串可直接传入工具。自动生成 JavaScript 源码时，`JSON.stringify` 可编码已有字符串，
前提是已经取得正确的文本值。Shell 引号、here-string 和其他语言的注释只在各自的解析层生效。
服务接收构造后的补丁原文，不额外转义或猜测修复。
语言语义见 [模板字面量](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-template-literals)、
[String.raw](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.raw) 和
[Array.prototype.join](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.join)。

## Windows 路径、正则与多行脚本

JavaScript 普通字符串会先解释反斜杠。多行 Shell 脚本可用 `String.raw` 保留这一层反斜杠；
PowerShell 仍按自己的引号和正则规则解析。最终 MCP 的 source 字段是字符串，JSON 编码由客户端完成。

```js
const cmd = String.raw`
$literalPath = 'C:\Windows\System32'
$pattern = 'Sig\['
$matched = 'Sig[42]' | Select-String -Pattern $pattern
[pscustomobject]@{ path = $literalPath; pattern = $pattern; matched = [bool]$matched } | ConvertTo-Json -Compress
`;
text(await tools.exec_command({ cmd }));
```

String.raw 模板中的反引号和 `${...}` 仍按 JavaScript 语法处理。
复杂脚本也可以通过 apply_patch 创建脚本文件后执行，避免多层语言嵌套。

不同字段的 PowerShell 对象连续输出时，默认表格格式可能只显示首个对象的列。
需要程序读取这些对象时，可分别转成 JSON，以保留各自字段。

```js
text(await tools.exec_command({ cmd: String.raw`
[pscustomobject]@{ Id = 42 } | ConvertTo-Json -Compress
[pscustomobject]@{ OS = 'Windows'; Arch = 'x64' } | ConvertTo-Json -Compress
` }));
```

## 语法定位和重试

原生 host 报 SyntaxError 后，服务对实际收到的 source 做辅助解析，附请求 ID、源码 SHA-256 和可定位时的行列/短片段。
辅助检查只提供定位，语法是否可执行仍由 V8 判断；服务不预先执行修改后的源码。
Code Mode 前置代码不改变返回的原始 source 定位。若仅宿主拒绝了构造复杂的请求且确认未执行，
可以在检查请求后简化或拆分；组合独立操作则能减少外层 tool call，两者由实际任务权衡。

## 异步提问

```js
text(await tools.request_user_input_async({
  questions: [{
    title: "这个新模块使用哪种存储？",
    options: ["SQLite：本机持久化", "仅内存：重启清空"]
  }]
}));
```

await 只等待提交成功，不等待人回答。Web 需要已经启动，宿主需要提供对话标识。
用户选择、题目和补充随该对话的正常 exec/wait 响应送达，与主动补充使用同一通道；没有答案轮询工具。
问题提交后仍可继续不依赖答案的工作；答案不会撤回已经执行的操作。
