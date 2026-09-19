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
