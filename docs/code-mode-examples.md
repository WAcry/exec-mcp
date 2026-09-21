# Code Mode 的结果筛选与 PowerShell 示例

以下片段是 `exec.source` 中的 JavaScript；Shell 代码放在 `tools.exec_command({cmd})` 中。
调用发生在 exec-mcp 的实际机器，与其他独立容器的文件、进程和网络不共享。

## 输出先在代码里筛选

最终返回模型的文本合计上限为 36,000 UTF-8 字节。这是针对实际宿主输出窗口的保守保护，不是精确 token 计数，
也不是嵌套工具结果的上限。先处理原始结果，再决定 text 哪些部分：

```js
const result = await tools.exec_command({ cmd: "git status --short" });
text(result);
```

较大的日志可以先保存和查找，再只输出摘要：

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

后续可从 `load("build-result")` 分段取内容。store 依赖当前 ChatGPT 对话关联，是临时内存，不是持久文件。
上限保护只保留最终文本首尾，被省略内容不会由 wait 自动补发；在结束前保存需要复用的数据。
终端每次最多交回 4 MiB，未读内容用同一 session_id 的 write_stdin 续取；每个进程默认缓冲 16 MiB。
超过缓冲后中间日志会丢弃并返回 truncated/omitted_bytes，因此没有搜到错误不能证明全过程无错误。
确需完整原始日志时由调用方显式重定向文件；服务不替所有工具自动落盘。

## 等待终端结束，而不是每行日志都返回

顶层 `write_stdin` 可以使用以下参数；省略 `chars` 或传空字符串都是只读：

```json
{
  "session_id": "exec_command 返回的句柄",
  "yield_time_ms": 110000
}
```

进程结束或等待到期时返回，已有和新增输出不提前唤醒；省略等待时间同样默认 110 秒，以减少反复轮询。
超时不终止进程；还有 `session_id` 时可继续等待或读取。进程结束但剩余输出超过单次读取上限时，也需继续读取。
写入 `chars` 后也使用相同等待规则。需要及时查看交互提示时，可设较短窗口（如 `yield_time_ms: 1000`）；`0` 立即读取。

exec 内使用相同参数，仍可在返回模型前筛选结果：

```js
const result = await tools.write_stdin({ session_id: "之前的句柄" });
text(result);
```

这是对现有终端的等待，不是新的 cell；exec 本身仍可能先交回 `cell_id`，由外层 `wait` 续取。
等待不扩大日志或模型输出预算，也不会把交互提示自动回答掉。

## 脚本完成与命令成功是两件事

`Script completed` 只表示 JavaScript 已结束；嵌套命令仍可能返回 `exit_code: 1`。
`exit_code` 是 Shell 退出码，管道的 `stderr_bytes` 表示累计收到的错误流字节（包括可能已滚动移除的内容），
错误流也可能只是进度或警告；PTY 本身合并流，没有独立错误流计数。

例如 PowerShell：

```js
text(await tools.exec_command({
  cmd: "Write-Error 'expected diagnostic'; Write-Output 'later success'"
}));
```

这里可能 `exit_code: 0`，但错误文本和 stderr_bytes 仍然存在。需要遇到 PowerShell 错误即停止时，由调用方显式设定：

```js
text(await tools.exec_command({
  cmd: "$ErrorActionPreference='Stop'; Write-Error 'stop here'; Write-Output 'should-not-run'"
}));
```

服务不擅自修改错误策略。原生程序的退出码可用 `exit $LASTEXITCODE` 显式传回。

## 在 exec 中查阅下游工具

`ALL_TOOLS` 是 `{name, description}[]`；description 包含完整的输入、返回契约，工具名称与 `tools` 上的绑定一致。
按名称或描述筛选并显式输出，或只列名称缩小范围：

```js
text(ALL_TOOLS.filter(t => /github|pull_request/i.test(t.name + " " + t.description)));
```

阅读命中项后使用它的准确名称调用 `await tools[name](args)`；已知名称和参数可以直接调用。
这是当前 exec 的已绑定快照，筛选本身不连接或执行下游，也不自动把完整目录加入模型上下文。

## 原文参数与 JavaScript 源码

本机/发现工具同时支持顶层调用和 exec 内的 tools.*。顶层 exec_command 的 cmd 是 Shell 原文；
apply_patch 接收 `{patch,workdir?}`，patch 是补丁原文。传输仍需正常 JSON 编码，但不再增加一层 JavaScript 模板求值。
因此 PowerShell 的反引号、here-string 中嵌套 JavaScript 的模板及 Markdown 围栏可保留原样。

例如，把下面原文放入顶层 apply_patch 的 patch 字段，workdir 指向目标项目即可：

````diff
*** Begin Patch
*** Add File: literal-example.md
+# 原文示例
+Inline: `review`，字面量 ${name}，路径 C:\work\new\file.txt。
+```powershell
+Write-Output "`tname`nnext"
+```
*** End Patch
````

exec 的 source 始终是 JavaScript；Shell 的单引号、here-string、嵌套脚本中的注释都不能改变外层 JS 的分隔符语法。
下面的 String.raw 写法只用于在 JavaScript 中构造字符串；已经取得的字符串值直接传递即可，不需要重新插入源码。

## 在 exec 内构造含 Markdown 的多行补丁

`String.raw` 保留反斜杠，但模板正文中的反引号仍结束模板，`${...}` 仍执行插值。
Markdown 的内联代码和围栏使用字符串值插入，字面量 `${name}` 也这样处理；
插入的值只是文本，不会再次作为 JavaScript 解析。

```js
const patch = String.raw`*** Begin Patch
*** Add File: patch-example.md
+# Review notes
+Use ${"`"}review${"`"} mode.
+${"`".repeat(3)}console
+uv run demo.py
+${"`".repeat(3)}
+Literal placeholder: ${"${"}name}
+Windows path: C:\work\new\file.txt
+Regex: Sig\[\d+\]
+Literal escape: \uXXXX
*** End Patch
`;
text(await tools.apply_patch(patch));
```

这里的 ``${"`"}`` 是字符串插值，不是占位符替换；没有需要保证“不出现在正文里”的特殊符号。
同样适用于更新已有文件和一个补丁内的多个文件。补丁从第一字符的 `*** Begin Patch` 开始，
标记顶格；新增行的 `+` 后保留文件实际缩进。

在 `String.raw` 中用反斜杠转义反引号或美元插值开头，反斜杠也会进入最终文本，不能据此保证原文保真。
正文已在变量中时直接传递，或把该变量作为一个完整插值值；自动生成 JavaScript 源码时，可由
`JSON.stringify` 编码已有字符串。它无法修复在求值前就已经语法错误的模板。
不默认采用全局 `replaceAll`、Base64 或服务端猜测修复，避免误改正文、增加另一层编码或改变补丁内容。
语言语义见 [String.raw](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.raw)。

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

String.raw 模板仍有 JavaScript 的反引号和 `${...}` 语义，不能当作任意文本的无条件转义器。
复杂脚本也可以通过 apply_patch 创建脚本文件后执行，避免多层语言嵌套。

不同字段的 PowerShell 对象连续输出时，默认表格格式可能只显示首个对象的列。
面向代码的输出可分别转 JSON，避免把格式化空白误认为数据丢失：

```js
text(await tools.exec_command({ cmd: String.raw`
[pscustomobject]@{ Id = 42 } | ConvertTo-Json -Compress
[pscustomobject]@{ OS = 'Windows'; Arch = 'x64' } | ConvertTo-Json -Compress
` }));
```

## 语法定位和重试

原生 host 报 SyntaxError 后，服务对实际收到的 source 做辅助解析，附请求 ID、源码 SHA-256 和可定位时的行列/短片段。
辅助检查不替代 V8，不据此判定 V8 有 bug，也不预先执行另一份修改过的脚本。
Code Mode 前置代码不改变返回的原始 source 定位。若仅宿主拒绝了构造复杂的请求且确认未执行，
可将其拆成几个简单片段；通常仍优先在一次 exec 组合独立操作，减少外层 tool call。
